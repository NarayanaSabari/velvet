package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

// executablePath is replaced in tests so they never overwrite the test binary.
var executablePath = os.Executable

var downloadClient = &http.Client{Timeout: 2 * time.Minute}

func cmdUpdate(args []string, out, errOut io.Writer) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(errOut)
	server := fs.String("server", "", "Velvet server URL (default: VELVET_SERVER, this repository's velvet.yaml, or "+defaultServer+")")
	check := fs.Bool("check", false, "report whether an update is available without installing it")
	if err := fs.Parse(args); err != nil {
		return fail(exitUsage, "%s", err)
	}
	base := updateServer(*server)

	latest, err := fetch(base + "/download/VERSION")
	if err != nil {
		return fail(exitNetwork, "checking for updates: %s", err)
	}
	want := strings.TrimSpace(string(latest))
	if want == "" {
		return fail(exitAPI, "%s did not report a CLI version", base)
	}
	if want == version {
		fmt.Fprintf(out, "velvet %s is up to date\n", version)
		return nil
	}
	if *check {
		fmt.Fprintf(out, "velvet %s is available (installed: %s); run velvet update\n", want, version)
		return nil
	}
	if runtime.GOOS == "windows" {
		return fail(exitUsage, "self-update is not supported on Windows; reinstall from %s", base)
	}

	name := fmt.Sprintf("velvet-%s-%s", runtime.GOOS, runtime.GOARCH)
	binary, err := fetch(base + "/download/" + name)
	if err != nil {
		return fail(exitNetwork, "downloading %s: %s", name, err)
	}
	sums, err := fetch(base + "/download/SHA256SUMS")
	if err != nil {
		return fail(exitNetwork, "downloading checksums: %s", err)
	}
	sum := sha256.Sum256(binary)
	if expected := checksumFor(sums, name); expected == "" || expected != hex.EncodeToString(sum[:]) {
		return fail(exitAPI, "checksum mismatch for %s; not installing", name)
	}

	if err := replaceExecutable(binary); err != nil {
		return fail(1, "installing update: %s", err)
	}
	fmt.Fprintf(out, "Updated velvet %s to %s\n", version, want)
	return nil
}

// updateServer prefers an explicit choice, then the repository's server, so a
// self-hosted team updates from the server it already signs in to.
func updateServer(flagValue string) string {
	if flagValue != "" {
		return strings.TrimRight(flagValue, "/")
	}
	if env := os.Getenv("VELVET_SERVER"); env != "" {
		return strings.TrimRight(env, "/")
	}
	if wd, err := os.Getwd(); err == nil {
		if repo, err := config.Find(wd); err == nil {
			return repo.ServerURL()
		}
	}
	return defaultServer
}

func fetch(url string) ([]byte, error) {
	resp, err := downloadClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 256<<20))
}

func checksumFor(sums []byte, name string) string {
	scanner := bufio.NewScanner(strings.NewReader(string(sums)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			return fields[0]
		}
	}
	return ""
}

// replaceExecutable writes beside the running binary and renames over it, so
// an interrupted update leaves the old binary in place.
func replaceExecutable(binary []byte) error {
	path, err := executablePath()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".velvet-update-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(binary); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
