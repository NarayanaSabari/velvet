package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFindWalksUpToTheRepositoryFile(t *testing.T) {
	root := t.TempDir()
	link := Link{Server: "https://velvet.example.com", Organisation: "lab", Project: "web"}
	if _, err := Write(root, link); err != nil {
		t.Fatal(err)
	}
	deep := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	repo, err := Find(deep)
	if err != nil {
		t.Fatal(err)
	}
	if repo.Link != link || repo.Path != filepath.Join(root, FileName) {
		t.Fatalf("got %+v at %s", repo.Link, repo.Path)
	}
}

func TestFindWithoutAFileSaysToInit(t *testing.T) {
	if _, err := Find(t.TempDir()); err != ErrNotInitialised {
		t.Fatalf("got %v", err)
	}
}

// velvet.yaml is edited by hand and by agents, so anything velvet init could
// not have written is refused before a request is built from it.
func TestFindRejectsTamperedFiles(t *testing.T) {
	for name, body := range map[string]string{
		"credentials in server": "server: https://user:pw@velvet.example.com\norganisation: lab\nproject: web\n",
		"path in server":        "server: https://velvet.example.com/evil\norganisation: lab\nproject: web\n",
		"non-http server":       "server: file:///etc/passwd\norganisation: lab\nproject: web\n",
		"traversal in slug":     "server: https://velvet.example.com\norganisation: ../admin\nproject: web\n",
		"missing project":       "server: https://velvet.example.com\norganisation: lab\n",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, FileName), []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
			if _, err := Find(dir); err == nil {
				t.Fatal("tampered velvet.yaml was accepted")
			}
		})
	}
}

func TestFileStoreKeepsKeysPrivateAndSeparate(t *testing.T) {
	t.Setenv("VELVET_TOKEN", "")
	keys := Keys{Dir: t.TempDir(), NoKeychain: true}
	web := Link{Server: "https://velvet.example.com", Organisation: "lab", Project: "web"}
	api := Link{Server: "https://velvet.example.com", Organisation: "lab", Project: "api"}

	if _, err := keys.Save(web, "velvet_aaa"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Save(api, "velvet_bbb"); err != nil {
		t.Fatal(err)
	}
	if got, _ := keys.Load(web); got != "velvet_aaa" {
		t.Fatalf("web key = %q", got)
	}
	if got, _ := keys.Load(api); got != "velvet_bbb" {
		t.Fatalf("api key = %q", got)
	}

	path, _ := keys.filePath()
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("credentials file mode %v, want 0600", info.Mode().Perm())
		}
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "lab") || strings.Contains(string(raw), "web") {
		t.Fatal("credentials file names the organisation or project")
	}

	if err := keys.Delete(web); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Load(web); err != ErrNoKey {
		t.Fatalf("after delete got %v", err)
	}
	if got, _ := keys.Load(api); got != "velvet_bbb" {
		t.Fatal("deleting one key removed another")
	}
}

func TestEnvironmentTokenWinsForCI(t *testing.T) {
	t.Setenv("VELVET_TOKEN", "velvet_from_env")
	keys := Keys{Dir: t.TempDir(), NoKeychain: true}
	got, err := keys.Load(Link{Server: "https://v.example", Organisation: "lab", Project: "web"})
	if err != nil || got != "velvet_from_env" {
		t.Fatalf("got %q, %v", got, err)
	}
}
