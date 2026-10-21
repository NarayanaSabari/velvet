package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

type descendant struct {
	Link Link   `json:"link"`
	Hash string `json:"hash"`
}

func descendantLink(server, user string) Link {
	return Link{Server: server, Organisation: "@descendants", Project: user}
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// TrackProject records only credentials minted from this machine login. A hash
// prevents logout from deleting a slot since replaced by another account.
func (k Keys) TrackProject(link Link, user, token string) error {
	return k.mutateFile(func(entries map[string]string) error {
		id := fileKey(descendantLink(link.ServerURL(), user))
		var children []descendant
		if raw := entries[id]; raw != "" {
			if err := json.Unmarshal([]byte(raw), &children); err != nil {
				return err
			}
		}
		next := descendant{Link: link, Hash: tokenHash(token)}
		found := false
		for i, child := range children {
			if SameLink(child.Link, link) {
				children[i] = next
				found = true
			}
		}
		if !found {
			children = append(children, next)
		}
		raw, err := json.Marshal(children)
		if err != nil {
			return err
		}
		entries[id] = string(raw)
		return nil
	})
}

func (k Keys) deleteDescendants(server, user string) error {
	entries, err := k.readFile()
	if err != nil {
		return err
	}
	index := descendantLink(server, user)
	var children []descendant
	if raw := entries[fileKey(index)]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &children); err != nil {
			return err
		}
	}
	for _, child := range children {
		if child.Link.ServerURL() != server {
			return fmt.Errorf("invalid server in local descendant index")
		}
		token, err := k.LoadStored(child.Link)
		if errors.Is(err, ErrNoKey) {
			continue
		}
		if err != nil {
			return err
		}
		if tokenHash(token) == child.Hash {
			if err := k.Delete(child.Link); err != nil {
				return err
			}
		}
	}
	return k.updateFile(index, "")
}
