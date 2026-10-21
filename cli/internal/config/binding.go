package config

import (
	"path/filepath"
)

// HasBinding finds a private binding before normal commands select cached keys.
// Legacy and cloned directories must first run terminal-only init to confirm.
func (k Keys) HasBinding(dir string) (bool, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return false, err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return false, err
	}
	for {
		_, ok, err := k.Binding(dir)
		if err != nil || ok {
			return ok, err
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false, nil
		}
		dir = parent
	}
}
