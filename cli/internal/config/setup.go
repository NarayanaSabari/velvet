package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".velvet-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// ValidateServer applies the same trust boundary as a repository link.
func ValidateServer(server string) error {
	return (Link{Server: server, Organisation: "valid", Project: "valid"}).Validate()
}

func setupLink(server, user string) Link {
	return Link{Server: strings.TrimRight(server, "/"), Organisation: "@setup", Project: user}
}

func activeLink(server string) Link {
	return Link{Server: strings.TrimRight(server, "/"), Organisation: "@active"}
}

// SaveLogin keeps setup credentials separate from every project credential.
func (k Keys) SaveLogin(server, user, token string) (string, error) {
	if user == "" || token == "" {
		return "", errors.New("incomplete login identity")
	}
	p := setupLink(server, user)
	old, oldErr := k.LoadStored(p)
	if oldErr != nil && !errors.Is(oldErr, ErrNoKey) {
		return "", oldErr
	}
	where, err := k.Save(p, token)
	if err != nil {
		return "", err
	}
	if err := k.updateFile(activeLink(server), user); err != nil {
		var restore error
		if oldErr == nil {
			_, restore = k.Save(p, old)
		} else {
			restore = k.Delete(p)
		}
		return "", errors.Join(err, restore)
	}
	return where, nil
}

var ErrNoLogin = errors.New("not signed in on this server; run velvet login")

// Login loads only private storage, never VELVET_TOKEN or repository YAML.
func (k Keys) Login(server, user string) (string, string, error) {
	if user == "" {
		entries, err := k.readFile()
		if err != nil {
			return "", "", err
		}
		user = entries[fileKey(activeLink(server))]
	}
	if user == "" {
		return "", "", ErrNoLogin
	}
	token, err := k.LoadStored(setupLink(server, user))
	if errors.Is(err, ErrNoKey) {
		err = ErrNoLogin
	}
	return user, token, err
}

func (k Keys) DeleteLogin(server, user string) error {
	if err := k.deleteDescendants(server, user); err != nil {
		return err
	}
	if err := k.Delete(setupLink(server, user)); err != nil {
		return err
	}
	entries, err := k.readFile()
	if err != nil {
		return err
	}
	if entries[fileKey(activeLink(server))] == user {
		return k.updateFile(activeLink(server), "")
	}
	return nil
}

func bindingLink(dir string) (Link, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return Link{}, err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return Link{}, err
	}
	return Link{Server: "@directory:" + filepath.Clean(dir)}, nil
}

// Binding is private and independent of editable YAML. Canonical directory names
// also make a symlink alias use the same binding as its real directory.
func (k Keys) Binding(dir string) (Link, bool, error) {
	id, err := bindingLink(dir)
	if err != nil {
		return Link{}, false, err
	}
	entries, err := k.readFile()
	if err != nil {
		return Link{}, false, err
	}
	raw, ok := entries[fileKey(id)]
	if !ok {
		return Link{}, false, nil
	}
	var link Link
	if err := json.Unmarshal([]byte(raw), &link); err != nil {
		return Link{}, false, err
	}
	if err := link.Validate(); err != nil {
		return Link{}, false, err
	}
	return link, true, nil
}

func (k Keys) Bind(dir string, link Link) error {
	if err := link.Validate(); err != nil {
		return err
	}
	id, err := bindingLink(dir)
	if err != nil {
		return err
	}
	link.Server = link.ServerURL()
	raw, err := json.Marshal(link)
	if err != nil {
		return err
	}
	return k.updateFile(id, string(raw))
}

func (k Keys) Unbind(dir string) error {
	id, err := bindingLink(dir)
	if err != nil {
		return err
	}
	return k.updateFile(id, "")
}

// CheckBinding checks all ancestors, including bindings whose YAML was deleted.
// No credential may be selected or sent until this check succeeds.
func (k Keys) CheckBinding(dir string, link Link) error {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	for {
		bound, ok, err := k.Binding(dir)
		if err != nil {
			return err
		}
		if ok {
			if !SameLink(bound, link) {
				return fmt.Errorf("private directory binding differs from velvet.yaml; run velvet init --relink to confirm a new project")
			}
			return nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil
		}
		dir = parent
	}
}

func SameLink(a, b Link) bool {
	return a.ServerURL() == b.ServerURL() && a.Organisation == b.Organisation && a.Project == b.Project
}

// LinkDirectory atomically replaces YAML, rolling it back if private binding
// persistence fails. Credentials must already be stored before calling it.
func (k Keys) LinkDirectory(dir string, link Link) (string, error) {
	path := filepath.Join(dir, FileName)
	old, err := os.ReadFile(path)
	existed := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	path, err = Write(dir, link)
	if err != nil {
		return "", err
	}
	if err := k.Bind(dir, link); err != nil {
		var rollback error
		if existed {
			rollback = atomicWrite(path, old, 0o644)
		} else {
			rollback = os.Remove(path)
		}
		return "", errors.Join(err, rollback)
	}
	return path, nil
}
