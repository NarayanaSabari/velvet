package config

import (
	"errors"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestDeleteClearsFallbackAndReportsKeychainFailure(t *testing.T) {
	t.Setenv("VELVET_NO_KEYCHAIN", "")
	unavailable := errors.New("keychain unavailable")
	keyring.MockInitWithError(unavailable)
	t.Cleanup(keyring.MockInit)
	keys := Keys{Dir: t.TempDir()}
	link := Link{Server: "https://velvet.example.com", Organisation: "lab", Project: "web"}
	if _, err := keys.Save(link, "test-project-secret"); err != nil {
		t.Fatal(err)
	}
	if err := keys.Delete(link); !errors.Is(err, unavailable) {
		t.Fatalf("keychain cleanup failure was hidden: %v", err)
	}
	entries, err := keys.readFile()
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := entries[fileKey(link)]; exists {
		t.Fatal("fallback credential survived a keychain cleanup failure")
	}
}
