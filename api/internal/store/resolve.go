package store

import (
	"context"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// RepoResolution names the organisation and project a checkout belongs to, so
// an agent can be configured once and still know where it is.
type RepoResolution struct {
	WorkspaceSlug string  `json:"workspace_slug"`
	WorkspaceName string  `json:"workspace_name"`
	Owner         string  `json:"owner"`
	Name          string  `json:"name"`
	ProjectKey    *string `json:"project_key"`
	ProjectName   *string `json:"project_name"`
	IssuePrefix   string  `json:"issue_prefix"`
}

var (
	// git@github.com:owner/repo.git, the scp-like form.
	sshRemoteRe = regexp.MustCompile(`(?i)^(?:[\w.-]+@)?[\w.-]+:([\w.-]+)/([\w.-]+?)(?:\.git)?/?$`)
	// A URL form: https, http, ssh, or git, with optional credentials and port.
	urlRemoteRe = regexp.MustCompile(`(?i)^(?:https?|ssh|git)://(?:[^@/]+@)?[\w.-]+(?::\d+)?/([\w.-]+)/([\w.-]+?)(?:\.git)?/?$`)
	// owner/repo, for a caller that already knows both.
	plainRemoteRe = regexp.MustCompile(`^([\w.-]+)/([\w.-]+?)(?:\.git)?$`)
)

// ParseRemote extracts owner and repository from a git remote in any of the
// forms git actually produces. Returning ok=false rather than guessing keeps
// an unrecognised remote from resolving to the wrong organisation.
func ParseRemote(remote string) (owner, name string, ok bool) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return "", "", false
	}
	for _, re := range []*regexp.Regexp{urlRemoteRe, sshRemoteRe, plainRemoteRe} {
		if m := re.FindStringSubmatch(remote); m != nil {
			return m[1], m[2], true
		}
	}
	return "", "", false
}

// ResolveRepo finds which of the caller's organisations holds this repository.
//
// Only organisations the caller belongs to are considered, and a repository
// that matches none is not found rather than guessed at: an agent writing a
// work-log entry into the wrong client's organisation is worse than one that
// asks to be told where it is.
func (s *Store) ResolveRepo(ctx context.Context, userID uuid.UUID, remote string) (RepoResolution, error) {
	owner, name, ok := ParseRemote(remote)
	if !ok {
		return RepoResolution{}, ErrNotFound
	}

	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, w.name, r.owner, r.name, p.key, p.name, w.issue_prefix
		FROM repo r
		JOIN workspace w ON w.id = r.workspace_id
		JOIN membership m ON m.workspace_id = w.id AND m.user_id = $1
		LEFT JOIN project p ON p.id = r.project_id
		WHERE lower(r.owner) = lower($2) AND lower(r.name) = lower($3)
		ORDER BY r.disconnected_at NULLS FIRST, w.slug
		LIMIT 2`, userID, owner, name)
	if err != nil {
		return RepoResolution{}, err
	}
	defer rows.Close()

	var found []RepoResolution
	for rows.Next() {
		var r RepoResolution
		if err := rows.Scan(&r.WorkspaceSlug, &r.WorkspaceName, &r.Owner, &r.Name,
			&r.ProjectKey, &r.ProjectName, &r.IssuePrefix); err != nil {
			return RepoResolution{}, err
		}
		found = append(found, r)
	}
	if err := rows.Err(); err != nil {
		return RepoResolution{}, err
	}

	switch len(found) {
	case 0:
		return RepoResolution{}, ErrNotFound
	case 1:
		return found[0], nil
	default:
		// The same repository connected to two of the caller's organisations
		// has no single right answer, so the caller is told to be explicit
		// rather than silently given one of them.
		return RepoResolution{}, ErrAmbiguousReference
	}
}
