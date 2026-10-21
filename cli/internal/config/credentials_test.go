package config

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCredentialStoreProcess(t *testing.T) {
	dir := os.Getenv("VELVET_CREDENTIAL_TEST_DIR")
	if dir == "" {
		return
	}
	if _, err := io.ReadAll(os.Stdin); err != nil {
		t.Fatal(err)
	}
	keys := Keys{Dir: dir, NoKeychain: true}
	link := Link{Server: "https://velvet.example.com", Organisation: "lab", Project: os.Getenv("VELVET_CREDENTIAL_TEST_PROJECT")}
	for range 10 {
		if _, err := keys.Save(link, "velvet_test"); err != nil {
			t.Fatal(err)
		}
		if err := keys.Delete(link); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := keys.Save(link, "velvet_test"); err != nil {
		t.Fatal(err)
	}
}

func TestCredentialStoreConcurrentProcesses(t *testing.T) {
	t.Setenv("VELVET_TOKEN", "")
	keys := Keys{Dir: t.TempDir(), NoKeychain: true}
	link := Link{Server: "https://velvet.example.com", Organisation: "lab", Project: "untouched"}
	if _, err := keys.Save(link, "velvet_keep"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	type process struct {
		cmd  *exec.Cmd
		gate io.WriteCloser
		out  bytes.Buffer
	}
	processes := make([]process, 10)
	for i := range processes {
		p := &processes[i]
		p.cmd = exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCredentialStoreProcess$", "-test.count=1")
		p.cmd.Env = append(os.Environ(), "VELVET_CREDENTIAL_TEST_DIR="+keys.Dir, fmt.Sprintf("VELVET_CREDENTIAL_TEST_PROJECT=project-%d", i))
		p.cmd.Stdout, p.cmd.Stderr = &p.out, &p.out
		var err error
		p.gate, err = p.cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := p.cmd.Start(); err != nil {
			t.Fatal(err)
		}
	}
	for i := range processes {
		if err := processes[i].gate.Close(); err != nil {
			t.Fatal(err)
		}
	}
	for i := range processes {
		p := &processes[i]
		if err := p.cmd.Wait(); err != nil {
			t.Errorf("credential process %d: %v\n%s", i, err, p.out.String())
		}
	}
	if got, err := keys.Load(link); err != nil || got != "velvet_keep" {
		t.Fatalf("unrelated key lost: %q, %v", got, err)
	}
	for i := range processes {
		link.Project = fmt.Sprintf("project-%d", i)
		if got, err := keys.Load(link); err != nil || got != "velvet_test" {
			t.Errorf("project %d key lost: %q, %v", i, got, err)
		}
	}
	leftovers, err := filepath.Glob(filepath.Join(keys.Dir, ".credentials-*"))
	if err != nil || len(leftovers) != 0 {
		t.Fatalf("temporary credential files left behind: %v, %v", leftovers, err)
	}
}

func TestCredentialStoreDoesNotOverwriteCorruptData(t *testing.T) {
	keys := Keys{Dir: t.TempDir(), NoKeychain: true}
	path, err := keys.filePath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("broken-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := Link{Server: "https://velvet.example.com", Organisation: "lab", Project: "web"}
	if _, err := keys.Save(link, "velvet_test"); err == nil {
		t.Fatal("save must refuse corrupt credentials")
	}
	if err := keys.Delete(link); err == nil {
		t.Fatal("delete must refuse corrupt credentials")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "broken-json" {
		t.Fatalf("corrupt file was replaced: %q, %v", data, err)
	}
}
