package store

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// WorklogEntry is one thing a person did, in one organisation, on one day.
// Entries from every organisation the caller belongs to are returned together,
// because "what did I work on last week" is not a question about one
// organisation at a time.
type WorklogEntry struct {
	// Day is the local calendar day, which is the unit a person actually
	// remembers work in.
	Day           string  `json:"day"`
	At            string  `json:"at"`
	WorkspaceSlug string  `json:"workspace_slug"`
	WorkspaceName string  `json:"workspace_name"`
	ProjectKey    *string `json:"project_key"`
	ProjectName   *string `json:"project_name"`
	// Kind is note, issue, pull_request, or commit.
	Kind     string  `json:"kind"`
	Source   string  `json:"source,omitempty"`
	NoteKind *string `json:"note_kind,omitempty"`
	IssueKey *string `json:"issue_key,omitempty"`
	Title    string  `json:"title"`
	Body     string  `json:"body,omitempty"`
	URL      string  `json:"url,omitempty"`
	Status   string  `json:"status,omitempty"`
}

// WorklogFilter narrows the recap. An empty filter returns the default window.
type WorklogFilter struct {
	From      string
	To        string
	Workspace string
	Project   string
	Limit     int
}

const (
	defaultWorklogDays  = 7
	defaultWorklogLimit = 500
	maxWorklogLimit     = 2000
)

// Worklog assembles everything one person did across every organisation they
// belong to: the notes they wrote, the tickets they touched, and the pull
// requests and commits that prove it.
//
// Each source is read with its own query rather than one union, because the
// four have genuinely different shapes and a union large enough to hold all of
// them would be harder to read than the sum of its parts.
func (s *Store) Worklog(ctx context.Context, userID uuid.UUID, f WorklogFilter) ([]WorklogEntry, error) {
	from, to, err := worklogWindow(f)
	if err != nil {
		return nil, err
	}
	limit := f.Limit
	if limit <= 0 {
		limit = defaultWorklogLimit
	}
	if limit > maxWorklogLimit {
		limit = maxWorklogLimit
	}

	// Membership is the only scope: a recap must never show another person's
	// work, nor work from an organisation this person has left.
	args := []any{userID, from, to, nullableText(f.Workspace), nullableText(f.Project), limit}

	out := []WorklogEntry{}
	for _, q := range []string{worklogNotes, worklogIssues, worklogPullRequests, worklogCommits} {
		rows, err := s.pool.Query(ctx, q, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var e WorklogEntry
			if err := rows.Scan(&e.Day, &e.At, &e.WorkspaceSlug, &e.WorkspaceName,
				&e.ProjectKey, &e.ProjectName, &e.Kind, &e.Source, &e.NoteKind,
				&e.IssueKey, &e.Title, &e.Body, &e.URL, &e.Status); err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, e)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	// Newest first, which is the order someone reads their own week in.
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// worklogWindow defaults to the last seven days, which is the span of the
// question this endpoint exists to answer.
func worklogWindow(f WorklogFilter) (string, string, error) {
	from, to := strings.TrimSpace(f.From), strings.TrimSpace(f.To)
	if to == "" {
		to = time.Now().UTC().Format("2006-01-02")
	}
	if from == "" {
		parsed, err := time.Parse("2006-01-02", to)
		if err != nil {
			return "", "", fmt.Errorf("%w: dates must be YYYY-MM-DD", ErrInvalidCursor)
		}
		from = parsed.AddDate(0, 0, -(defaultWorklogDays - 1)).Format("2006-01-02")
	}
	for _, d := range []string{from, to} {
		if _, err := time.Parse("2006-01-02", d); err != nil {
			return "", "", fmt.Errorf("%w: dates must be YYYY-MM-DD", ErrInvalidCursor)
		}
	}
	if from > to {
		return "", "", fmt.Errorf("%w: from must not be after to", ErrInvalidCursor)
	}
	return from, to, nil
}

// WindowForDays turns "the last N days" into the date range it means,
// counting today as the first day so `days=1` is today and `days=7` is the
// past week including today.
func WindowForDays(days int) (from, to string) {
	if days < 1 {
		days = defaultWorklogDays
	}
	now := time.Now().UTC()
	return now.AddDate(0, 0, -(days - 1)).Format("2006-01-02"), now.Format("2006-01-02")
}

func nullableText(v string) *string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(v)
	return &trimmed
}

// The four queries share a shape: scope by membership, bound by the window,
// optionally narrow to one organisation or project, and project the common
// columns so one scan serves them all.
const worklogScope = `
	JOIN workspace w ON w.id = src.workspace_id
	JOIN membership m ON m.workspace_id = w.id AND m.user_id = $1
	WHERE src.created_at::date BETWEEN $2::date AND $3::date
	  AND ($4::text IS NULL OR w.slug = $4)`

const worklogNotes = `
	SELECT to_char(src.created_at, 'YYYY-MM-DD'),
	       to_char(src.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	       w.slug, w.name, p.key, p.name,
	       'note', src.source, src.kind,
	       i.key,
	       COALESCE(i.title, p.name, ''),
	       src.body, '', ''
	FROM comment src
	LEFT JOIN issue i ON src.target_type = 'issue' AND i.id = src.target_id
	LEFT JOIN project p ON p.id = COALESCE(
	    CASE WHEN src.target_type = 'project' THEN src.target_id END, i.project_id)` +
	worklogScope + `
	  AND src.author_id = $1 AND src.deleted_at IS NULL
	  AND ($5::text IS NULL OR p.key = $5)
	ORDER BY src.created_at DESC
	LIMIT $6`

// An issue counts as worked on when this person created it or is assigned it,
// and updated_at is when that work last showed.
const worklogIssues = `
	SELECT to_char(src.updated_at, 'YYYY-MM-DD'),
	       to_char(src.updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	       w.slug, w.name, p.key, p.name,
	       'issue', '', NULL, src.key, src.title, '', '', src.status::text
	FROM issue src
	LEFT JOIN project p ON p.id = src.project_id
	JOIN workspace w ON w.id = src.workspace_id
	JOIN membership m ON m.workspace_id = w.id AND m.user_id = $1
	WHERE src.updated_at::date BETWEEN $2::date AND $3::date
	  AND ($4::text IS NULL OR w.slug = $4)
	  AND (src.assignee_id = $1 OR src.created_by = $1)
	  AND ($5::text IS NULL OR p.key = $5)
	ORDER BY src.updated_at DESC
	LIMIT $6`

const worklogPullRequests = `
	SELECT to_char(COALESCE(src.gh_updated_at, src.updated_at), 'YYYY-MM-DD'),
	       to_char(COALESCE(src.gh_updated_at, src.updated_at), 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	       w.slug, w.name, p.key, p.name,
	       'pull_request', '', NULL, i.key, src.title, '', src.html_url, src.state::text
	FROM pull_request src
	LEFT JOIN pr_link l ON l.pull_request_id = src.id
	LEFT JOIN issue i ON i.id = l.issue_id
	LEFT JOIN repo r ON r.id = src.repo_id
	LEFT JOIN project p ON p.id = COALESCE(i.project_id, r.project_id)
	JOIN workspace w ON w.id = src.workspace_id
	JOIN membership m ON m.workspace_id = w.id AND m.user_id = $1
	WHERE COALESCE(src.gh_updated_at, src.updated_at)::date BETWEEN $2::date AND $3::date
	  AND ($4::text IS NULL OR w.slug = $4)
	  AND src.author_id = $1
	  AND ($5::text IS NULL OR p.key = $5)
	ORDER BY COALESCE(src.gh_updated_at, src.updated_at) DESC
	LIMIT $6`

// A commit is attributed through the organisation's GitHub identity, so
// someone using a different account per client still sees their own commits.
const worklogCommits = `
	SELECT to_char(src.committed_at, 'YYYY-MM-DD'),
	       to_char(src.committed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	       w.slug, w.name, p.key, p.name,
	       'commit', '', NULL, i.key, src.message, '', src.html_url, ''
	FROM commit_ref src
	LEFT JOIN issue i ON i.id = src.issue_id
	LEFT JOIN repo r ON r.id = src.repo_id
	LEFT JOIN project p ON p.id = COALESCE(i.project_id, r.project_id)
	JOIN workspace w ON w.id = src.workspace_id
	JOIN membership m ON m.workspace_id = w.id AND m.user_id = $1
	LEFT JOIN membership_github_identity gi ON gi.membership_id = m.id
	LEFT JOIN app_user u ON u.id = $1
	WHERE src.committed_at::date BETWEEN $2::date AND $3::date
	  AND ($4::text IS NULL OR w.slug = $4)
	  AND lower(src.author_login) = lower(COALESCE(gi.github_login, u.github_login))
	  AND ($5::text IS NULL OR p.key = $5)
	ORDER BY src.committed_at DESC
	LIMIT $6`
