//go:build !windows

package config

import (
	"os"
	"syscall"
)

// Closing the file releases the lock, including when its process exits.
func lockCredentialsFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX)
}
