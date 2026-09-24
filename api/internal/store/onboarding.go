package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"golang.org/x/text/unicode/norm"
)

// ReservedWorkspaceSlugs are paths the web app routes itself, so an
// organisation may not claim them.
var ReservedWorkspaceSlugs = map[string]bool{
	"admin": true, "api": true, "auth": true, "check-email": true, "expired": true,
	"invite": true, "invites": true, "me": true, "new": true, "onboarding": true, "orgs": true,
	"settings": true, "signin": true, "signout": true, "w": true, "webhooks": true,
}

// OrganisationDefaults is what a new person's first organisation is called
// before they change anything: their own name, a slug from it, and a prefix
// from its initials.
type OrganisationDefaults struct {
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	IssuePrefix string `json:"issue_prefix"`
}

// DefaultOrganisationName is the person's name, or the part of their email
// before the @ when they have not given one. It never returns an empty name.
func DefaultOrganisationName(user User) string {
	if name := strings.Join(strings.Fields(user.Name), " "); name != "" {
		return truncateRunes(name, 80)
	}
	local, _, _ := strings.Cut(user.Email, "@")
	local = strings.NewReplacer(".", " ", "_", " ", "-", " ", "+", " ").Replace(local)
	words := strings.Fields(local)
	for i, word := range words {
		runes := []rune(strings.ToLower(word))
		runes[0] = unicode.ToUpper(runes[0])
		words[i] = string(runes)
	}
	if name := strings.Join(words, " "); name != "" {
		return truncateRunes(name, 80)
	}
	return "My organisation"
}

// SlugFrom turns a display name into a valid organisation slug, dropping
// accents rather than characters so "Sébastien" becomes "sebastien".
func SlugFrom(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range norm.NFKD.String(strings.ToLower(name)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case unicode.Is(unicode.Mn, r):
			// Combining accent from the decomposition: drop it, keep the letter.
		default:
			if b.Len() > 0 && !dash {
				b.WriteByte('-')
				dash = true
			}
		}
	}
	slug := strings.Trim(b.String(), "-")
	if len(slug) > 40 {
		slug = strings.TrimRight(slug[:40], "-")
	}
	switch {
	case slug == "":
		// A name in a script with no Latin transliteration, such as Tamil,
		// leaves nothing usable; the person can still rename it.
		return "my-work"
	case len(slug) < 3 || ReservedWorkspaceSlugs[slug]:
		return slug + "-work"
	}
	return slug
}

// PrefixFrom takes up to three initials from a name, padding a one-word name
// with its following letters, so "Sabari Narayana" becomes "SN" and "Velvet"
// becomes "VEL".
func PrefixFrom(name string) string {
	var letters []rune
	for _, r := range norm.NFKD.String(strings.ToUpper(name)) {
		if r >= 'A' && r <= 'Z' || r == ' ' {
			letters = append(letters, r)
		}
	}
	words := strings.Fields(string(letters))
	var prefix []rune
	for _, word := range words {
		if len(prefix) == 3 {
			break
		}
		prefix = append(prefix, []rune(word)[0])
	}
	if len(prefix) < 2 && len(words) > 0 {
		prefix = []rune(words[0])
		if len(prefix) > 3 {
			prefix = prefix[:3]
		}
	}
	if len(prefix) < 2 {
		return "WRK"
	}
	return string(prefix)
}

// SuggestOrganisation proposes defaults for the person's first organisation,
// choosing a slug nobody has taken yet.
func (s *Store) SuggestOrganisation(ctx context.Context, user User) (OrganisationDefaults, error) {
	name := DefaultOrganisationName(user)
	slug, err := s.freeSlug(ctx, SlugFrom(name))
	if err != nil {
		return OrganisationDefaults{}, err
	}
	return OrganisationDefaults{Name: name, Slug: slug, IssuePrefix: PrefixFrom(name)}, nil
}

// CreateWorkspaceWithFreeSlug creates the organisation, moving to the next
// numbered slug when the requested one was taken in the meantime, so two
// people named Sam signing up together both succeed.
func (s *Store) CreateWorkspaceWithFreeSlug(ctx context.Context, actorID uuid.UUID, name, slug, prefix string) (Membership, error) {
	candidate := slug
	for attempt := 2; attempt <= 50; attempt++ {
		m, err := s.CreateWorkspace(ctx, actorID, name, candidate, prefix)
		if !errors.Is(err, ErrDuplicate) {
			return m, err
		}
		candidate = numberedSlug(slug, attempt)
	}
	return Membership{}, ErrDuplicate
}

func (s *Store) freeSlug(ctx context.Context, base string) (string, error) {
	candidate := base
	for attempt := 2; attempt <= 50; attempt++ {
		var taken bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace WHERE slug=$1)`, candidate).Scan(&taken); err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
		candidate = numberedSlug(base, attempt)
	}
	return "", ErrDuplicate
}

func numberedSlug(base string, n int) string {
	suffix := fmt.Sprintf("-%d", n)
	if len(base)+len(suffix) > 40 {
		base = strings.TrimRight(base[:40-len(suffix)], "-")
	}
	return base + suffix
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit]))
}

// OnboardingState is where a person is in setting up Velvet for their agent.
type OnboardingState struct {
	HasOrganisation bool `json:"has_organisation"`
	HasToken        bool `json:"has_token"`
	// AgentConnected is true once any of the person's tokens has been used,
	// which is the moment a configured agent first reached Velvet.
	AgentConnected bool `json:"agent_connected"`
}

func (s *Store) Onboarding(ctx context.Context, userID uuid.UUID) (OnboardingState, error) {
	var state OnboardingState
	err := s.pool.QueryRow(ctx, `
		SELECT
			EXISTS (SELECT 1 FROM membership WHERE user_id=$1),
			EXISTS (SELECT 1 FROM api_token WHERE user_id=$1),
			EXISTS (SELECT 1 FROM api_token WHERE user_id=$1 AND last_used_at IS NOT NULL)`, userID).
		Scan(&state.HasOrganisation, &state.HasToken, &state.AgentConnected)
	return state, err
}
