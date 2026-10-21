package config

import (
	"os"

	"golang.org/x/sys/windows"
)

// Closing the file releases the lock, including when its process exits.
func lockCredentialsFile(file *os.File) error {
	return windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &windows.Overlapped{})
}
