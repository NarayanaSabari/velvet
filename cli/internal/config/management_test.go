package config

import (
	"errors"
	"testing"
)

func TestManagementCredentialsStaySeparate(t *testing.T) {
	t.Setenv("VELVET_NO_KEYCHAIN", "1")
	t.Setenv("VELVET_TOKEN", "untrusted-env-token")
	keys := Keys{Dir: t.TempDir(), NoKeychain: true}
	base := "https://velvet.example.com"
	project := Link{Server: base, Organisation: "lab", Project: "web"}
	if _, err := keys.SaveLogin(base, "user", "setup-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Save(project, "project-secret"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := keys.Management(base, ""); !errors.Is(err, ErrNoManagement) {
		t.Fatalf("setup became management: %v", err)
	}
	if _, err := keys.SaveManagement(base, "user", "management-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.SaveManagement("https://other.example.com", "user", "other-secret"); err != nil {
		t.Fatal(err)
	}
	user, token, err := keys.Management(base, "")
	if err != nil || user != "user" || token != "management-secret" {
		t.Fatalf("management=%q %q %v", user, token, err)
	}
	if _, token, err := keys.Login(base, ""); err != nil || token != "setup-secret" {
		t.Fatalf("setup overwritten: %q %v", token, err)
	}
	if err := keys.DeleteManagement(base, user); err != nil {
		t.Fatal(err)
	}
	if _, _, err := keys.Management(base, ""); !errors.Is(err, ErrNoManagement) {
		t.Fatalf("management survived: %v", err)
	}
	if _, token, err := keys.Login(base, ""); err != nil || token != "setup-secret" {
		t.Fatalf("setup removed: %q %v", token, err)
	}
	if token, err := keys.LoadStored(project); err != nil || token != "project-secret" {
		t.Fatalf("project removed: %q %v", token, err)
	}
	if _, token, err := keys.Management("https://other.example.com", ""); err != nil || token != "other-secret" {
		t.Fatalf("other server removed: %q %v", token, err)
	}
}

func TestManagementAccountSelection(t *testing.T) {
	keys := Keys{Dir: t.TempDir(), NoKeychain: true}
	base := "https://velvet.example.com"
	for _, user := range []string{"first", "second"} {
		if _, err := keys.SaveManagement(base, user, user+"-secret"); err != nil {
			t.Fatal(err)
		}
	}
	if err := keys.DeleteManagement(base, "first"); err != nil {
		t.Fatal(err)
	}
	if user, _, err := keys.Management(base, ""); err != nil || user != "second" {
		t.Fatalf("active account lost: %q %v", user, err)
	}
	if _, _, err := keys.Management(base, "first"); !errors.Is(err, ErrNoManagement) {
		t.Fatalf("deleted account returned: %v", err)
	}
	if _, err := keys.SaveManagement(base+"/attacker", "user", "secret"); err == nil {
		t.Fatal("invalid server accepted")
	}
}
