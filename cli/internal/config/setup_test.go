package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSetupStorageSeparatesServersAccountsAndEnvironment(t *testing.T) {
	keys := Keys{Dir: t.TempDir(), NoKeychain: true}
	t.Setenv("VELVET_TOKEN", "personal-env")
	for _, tc := range []struct{ server, user, token string }{
		{"https://one.example", "alice", "setup-a"},
		{"https://one.example", "bob", "setup-b"},
		{"https://two.example", "alice", "setup-other"},
	} {
		if _, err := keys.SaveLogin(tc.server, tc.user, tc.token); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct{ server, user, token string }{
		{"https://one.example", "alice", "setup-a"},
		{"https://one.example", "", "setup-b"},
		{"https://two.example", "", "setup-other"},
	} {
		_, got, err := keys.Login(tc.server, tc.user)
		if err != nil || got != tc.token {
			t.Fatalf("Login(%s,%s) = %q, %v", tc.server, tc.user, got, err)
		}
	}
	if _, _, err := keys.Login("https://missing.example", ""); !errors.Is(err, ErrNoLogin) {
		t.Fatalf("missing login: %v", err)
	}
}

func TestPrivateBindingCanonicalPathsAndAncestorProtection(t *testing.T) {
	keys := Keys{Dir: t.TempDir(), NoKeychain: true}
	root := t.TempDir()
	a := Link{Server: "https://one.example", Organisation: "lab", Project: "web"}
	b := a
	b.Project = "other"
	if err := keys.Bind(root, a); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "sub")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := keys.CheckBinding(nested, b); err == nil {
		t.Fatal("child bypassed parent binding")
	}
	if err := keys.CheckBinding(nested, a); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Skip(err)
	}
	if err := keys.CheckBinding(alias, b); err == nil {
		t.Fatal("symlink bypassed canonical binding")
	}
	// Explicitly confirmed nested links can override an ancestor binding.
	if err := keys.Bind(nested, b); err != nil {
		t.Fatal(err)
	}
	if err := keys.CheckBinding(nested, b); err != nil {
		t.Fatal(err)
	}
	if err := keys.CheckBinding(root, b); err == nil {
		t.Fatal("child binding changed parent")
	}
}

func TestLinkDirectoryRollsBackYAMLWhenPrivateBindingFails(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "new", true: "existing"}[existing], func(t *testing.T) {
			dir := t.TempDir()
			keys := Keys{Dir: t.TempDir(), NoKeychain: true}
			a := Link{Server: "https://one.example", Organisation: "lab", Project: "web"}
			b := a
			b.Project = "other"
			var before []byte
			path := filepath.Join(dir, FileName)
			if existing {
				if _, err := Write(dir, a); err != nil {
					t.Fatal(err)
				}
				before, _ = os.ReadFile(path)
			}
			credentials, _ := keys.filePath()
			if err := os.WriteFile(credentials, []byte("corrupt"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := keys.LinkDirectory(dir, b); err == nil {
				t.Fatal("accepted corrupt private storage")
			}
			after, err := os.ReadFile(path)
			if existing {
				if err != nil || string(before) != string(after) {
					t.Fatalf("YAML changed on failure: %s, %v", after, err)
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("failed init left YAML: %v", err)
			}
		})
	}
}

func TestLogoutClearsOnlyMatchingDescendantCredentials(t *testing.T) {
	keys := Keys{Dir: t.TempDir(), NoKeychain: true}
	server := "https://one.example"
	alice := Link{Server: server, Organisation: "lab", Project: "web"}
	replaced := alice
	replaced.Project = "shared"
	other := alice
	other.Server = "https://two.example"
	for _, p := range []Link{alice, replaced, other} {
		if _, err := keys.Save(p, "alice-child"); err != nil {
			t.Fatal(err)
		}
		if err := keys.TrackProject(p, "alice", "alice-child"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := keys.Save(replaced, "bob-child"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.SaveLogin(server, "alice", "setup-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.SaveLogin(server, "bob", "setup-b"); err != nil {
		t.Fatal(err)
	}
	if err := keys.DeleteLogin(server, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.LoadStored(alice); !errors.Is(err, ErrNoKey) {
		t.Fatalf("descendant survived: %v", err)
	}
	if got, err := keys.LoadStored(replaced); err != nil || got != "bob-child" {
		t.Fatalf("other account lost: %s, %v", got, err)
	}
	if got, err := keys.LoadStored(other); err != nil || got != "alice-child" {
		t.Fatalf("other server lost: %s, %v", got, err)
	}
	if _, got, err := keys.Login(server, ""); err != nil || got != "setup-b" {
		t.Fatalf("other active login lost: %s, %v", got, err)
	}
}

func TestServerURLRejectsAmbiguousBases(t *testing.T) {
	for _, base := range []string{"https://host/#x", "https://host/?", "https://host/?x=y", "https://host/%2f", "https:opaque", "https://user:pass@host", "https://host/api"} {
		if err := ValidateServer(base); err == nil {
			t.Errorf("accepted %q", base)
		}
	}
	for _, base := range []string{"https://host", "https://host/", "http://localhost:8080"} {
		if err := ValidateServer(base); err != nil {
			t.Errorf("rejected %q: %v", base, err)
		}
	}
}
