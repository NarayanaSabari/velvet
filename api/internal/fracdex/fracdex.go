// Package fracdex generates order keys that sit strictly between two existing
// keys, so reordering a list writes one row instead of renumbering a column.
package fracdex

import "errors"

const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

const base = len(digits)

// maxLen bounds the recursion depth. Reaching it means the inputs were not
// produced by this package, so failing loudly beats looping forever.
const maxLen = 64

var (
	ErrOutOfOrder = errors.New("fracdex: a must sort before b")
	ErrTooDeep    = errors.New("fracdex: no key fits between the given bounds")
)

func idx(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'A' && c <= 'Z':
		return int(c-'A') + 10
	case c >= 'a' && c <= 'z':
		return int(c-'a') + 36
	default:
		return -1
	}
}

// Between returns a key strictly between a and b in byte order. An empty a
// means "before everything" and an empty b means "after everything".
func Between(a, b string) (string, error) {
	if a != "" && b != "" && a >= b {
		return "", ErrOutOfOrder
	}
	for i := 0; i < len(a); i++ {
		if idx(a[i]) < 0 {
			return "", ErrOutOfOrder
		}
	}
	for i := 0; i < len(b); i++ {
		if idx(b[i]) < 0 {
			return "", ErrOutOfOrder
		}
	}

	out := make([]byte, 0, 8)
	// bFree records that the prefix built so far is already strictly less than
	// b, after which b no longer constrains the remaining digits.
	bFree := b == ""

	for i := 0; i < maxLen; i++ {
		da := 0
		if i < len(a) {
			da = idx(a[i])
		}
		db := base
		if !bFree {
			if i < len(b) {
				db = idx(b[i])
			} else {
				db = 0
			}
		}
		if da+1 < db {
			out = append(out, digits[(da+db)/2])
			return string(out), nil
		}
		out = append(out, digits[da])
		if !bFree && da < db {
			bFree = true
		}
	}
	return "", ErrTooDeep
}

// First returns the key for the first item in an empty list.
func First() string { return "V" }
