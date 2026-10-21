// Package config finds a repository's velvet.yaml and the key that goes with
// it.
//
// velvet.yaml names a server, an organisation, and a project. It holds no
// secret, so it is committed and shared. The key lives in the OS keychain
// (macOS Keychain, Windows Credential Manager, Secret Service on Linux), or in
// a 0600 file when no keychain is available.
//
// velvet.yaml is not a security boundary: an agent can edit it. The key the
// server issued is bound to one organisation and project, so pointing the file
// elsewhere only makes the server refuse.
package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/zalando/go-keyring"
	"go.yaml.in/yaml/v3"
)

// FileName is the per-repository config file.
const FileName = "velvet.yaml"

const keyringService = "velvet"

// Link is the parsed contents of velvet.yaml: which server, organisation,
// and project this repository logs to.
type Link struct {
	Server       string `yaml:"server"`
	Organisation string `yaml:"organisation"`
	Project      string `yaml:"project"`
}

// Repo is a velvet.yaml and where it was found.
type Repo struct {
	Link
	Path string
}

// ErrNotInitialised means no velvet.yaml exists at or above the directory.
var ErrNotInitialised = errors.New("no velvet.yaml here or in any parent directory; run velvet init")

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`)
var keyRe = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`)

// Validate rejects a file that could not have been written by velvet init,
// before any request is built from it.
func (p Link) Validate() error {
	u, err := url.Parse(p.Server)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return fmt.Errorf("velvet.yaml: server must be an http(s) URL such as https://velvet.example.com")
	}
	if !slugRe.MatchString(p.Organisation) {
		return fmt.Errorf("velvet.yaml: organisation %q is not a valid organisation slug", p.Organisation)
	}
	if !keyRe.MatchString(p.Project) {
		return fmt.Errorf("velvet.yaml: project %q is not a valid project key", p.Project)
	}
	return nil
}

// ServerURL is the server without a trailing slash.
func (p Link) ServerURL() string { return strings.TrimRight(p.Server, "/") }

// Find walks up from dir to the nearest velvet.yaml.
func Find(dir string) (Repo, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return Repo{}, err
	}
	for {
		path := filepath.Join(dir, FileName)
		data, err := os.ReadFile(path)
		if err == nil {
			var p Link
			if err := yaml.Unmarshal(data, &p); err != nil {
				return Repo{}, fmt.Errorf("%s: %w", path, err)
			}
			if err := p.Validate(); err != nil {
				return Repo{}, fmt.Errorf("%s: %w", path, err)
			}
			return Repo{Link: p, Path: path}, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return Repo{}, err
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return Repo{}, ErrNotInitialised
		}
		dir = parent
	}
}

// Write creates or replaces velvet.yaml in dir.
func Write(dir string, p Link) (string, error) {
	if err := p.Validate(); err != nil {
		return "", err
	}
	body := fmt.Sprintf(`# Links this repository to one Velvet project. Safe to commit: it holds no
# secret. Each person runs "velvet init" once to get their own key, which the
# server limits to exactly this organisation and project.
server: %s
organisation: %s
project: %s
`, p.ServerURL(), p.Organisation, p.Project)
	path := filepath.Join(dir, FileName)
	return path, os.WriteFile(path, []byte(body), 0o644)
}

// account names one key: a person may link several repositories, to
// different servers, organisations, and projects, each with its own key.
func account(p Link) string {
	return p.ServerURL() + "|" + p.Organisation + "|" + p.Project
}

// Keys stores keys in the OS keychain, falling back to a 0600 file in the
// user config directory when no keychain is available (CI, headless Linux).
type Keys struct {
	// Dir overrides the fallback file's directory, for tests.
	Dir string
	// NoKeychain forces the file store, for tests and VELVET_NO_KEYCHAIN.
	NoKeychain bool
}

func (k Keys) useKeychain() bool {
	return !k.NoKeychain && os.Getenv("VELVET_NO_KEYCHAIN") == ""
}

func (k Keys) filePath() (string, error) {
	dir := k.Dir
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(base, "velvet")
	}
	return filepath.Join(dir, "credentials.json"), nil
}

func (k Keys) readFile() (map[string]string, error) {
	path, err := k.filePath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return out, nil
}

func (k Keys) writeFile(entries map[string]string) error {
	path, err := k.filePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".credentials-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func (k Keys) updateFile(p Link, key string) error {
	path, err := k.filePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// Lock a separate inode: replacing credentials.json must not release the lock.
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := lockCredentialsFile(lock); err != nil {
		return err
	}
	entries, err := k.readFile()
	if err != nil {
		return err
	}
	if key == "" {
		if _, exists := entries[fileKey(p)]; !exists {
			return nil
		}
		delete(entries, fileKey(p))
	} else {
		entries[fileKey(p)] = key
	}
	return k.writeFile(entries)
}

// fileKey hashes the account name so the file does not list which
// organisations and projects the person works on.
func fileKey(p Link) string {
	sum := sha256.Sum256([]byte(account(p)))
	return hex.EncodeToString(sum[:])
}

// Save stores the key for p and reports where it went.
func (k Keys) Save(p Link, key string) (string, error) {
	if k.useKeychain() {
		if err := keyring.Set(keyringService, account(p), key); err == nil {
			return "the system keychain", nil
		}
	}
	if err := k.updateFile(p, key); err != nil {
		return "", err
	}
	path, _ := k.filePath()
	return path, nil
}

// ErrNoKey means velvet.yaml exists but this person has not run velvet init.
var ErrNoKey = errors.New("no key for this repository on this machine; run velvet init")

// Load returns the key for p. VELVET_TOKEN overrides the stores, for CI.
func (k Keys) Load(p Link) (string, error) {
	if token := strings.TrimSpace(os.Getenv("VELVET_TOKEN")); token != "" {
		return token, nil
	}
	if k.useKeychain() {
		if key, err := keyring.Get(keyringService, account(p)); err == nil && key != "" {
			return key, nil
		}
	}
	entries, err := k.readFile()
	if err != nil {
		return "", err
	}
	if key := entries[fileKey(p)]; key != "" {
		return key, nil
	}
	return "", ErrNoKey
}

// Delete removes the key for p from every store.
func (k Keys) Delete(p Link) error {
	if k.useKeychain() {
		_ = keyring.Delete(keyringService, account(p))
	}
	return k.updateFile(p, "")
}
