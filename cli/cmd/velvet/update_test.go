package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func updateServerFixture(t *testing.T, latest string, binary []byte, sum string) string {
	t.Helper()
	name := fmt.Sprintf("velvet-%s-%s", runtime.GOOS, runtime.GOARCH)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/download/VERSION":
			fmt.Fprintln(w, latest)
		case "/download/" + name:
			w.Write(binary)
		case "/download/SHA256SUMS":
			fmt.Fprintf(w, "%s  %s\n", sum, name)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func fakeExecutable(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "velvet")
	if err := os.WriteFile(path, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	previous := executablePath
	executablePath = func() (string, error) { return path, nil }
	t.Cleanup(func() { executablePath = previous })
	return path
}

func withVersion(t *testing.T, v string) {
	previous := version
	version = v
	t.Cleanup(func() { version = previous })
}

func TestUpdateInstallsVerifiedNewerBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("self-update is not supported on Windows")
	}
	withVersion(t, "old")
	path := fakeExecutable(t)
	sum := sha256.Sum256([]byte("new"))
	server := updateServerFixture(t, "new", []byte("new"), hex.EncodeToString(sum[:]))

	var out bytes.Buffer
	if err := run([]string{"update", "--check", "--server", server}, &out, io.Discard, nil); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); string(data) != "old" || !strings.Contains(out.String(), "new is available") {
		t.Fatalf("--check changed the binary or did not report: %q, %q", data, out.String())
	}

	out.Reset()
	if err := run([]string{"update", "--server", server}, &out, io.Discard, nil); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	info, _ := os.Stat(path)
	if string(data) != "new" || info.Mode().Perm() != 0o755 || !strings.Contains(out.String(), "Updated velvet old to new") {
		t.Fatalf("got %q mode %v, output %q", data, info.Mode().Perm(), out.String())
	}
	if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".velvet-update-*")); len(leftovers) != 0 {
		t.Fatalf("temporary files left: %v", leftovers)
	}
}

func TestUpdateSkipsCurrentAndRejectsBadChecksums(t *testing.T) {
	withVersion(t, "current")
	path := fakeExecutable(t)

	var out bytes.Buffer
	server := updateServerFixture(t, "current", []byte("new"), "unused")
	if err := run([]string{"update", "--server", server}, &out, io.Discard, nil); err != nil || !strings.Contains(out.String(), "up to date") {
		t.Fatalf("got %v, %q", err, out.String())
	}

	server = updateServerFixture(t, "newer", []byte("tampered"), strings.Repeat("0", 64))
	if err := run([]string{"update", "--server", server}, io.Discard, io.Discard, nil); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("tampered binary accepted: %v", err)
	}
	if data, _ := os.ReadFile(path); string(data) != "old" {
		t.Fatalf("failed update replaced the binary: %q", data)
	}
}
