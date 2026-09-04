package store

import (
	"context"

	"github.com/google/uuid"
)

// PersonActivityRow is one member's contribution over the period, with the
// verb breakdown beside the total so a big number made entirely of status
// flips reads differently from one made of written updates.
type PersonActivityRow struct {
	UserID      *uuid.UUID     `json:"user_id"`
	GitHubLogin string         `json:"github_login"`
	Name        string         `json:"name"`
	Verbs       map[string]int `json:"verbs"`
	Total       int            `json:"total"`
}

// MilestoneCompletionRow is one sprint's milestone completion rate.
type MilestoneCompletionRow struct {
	SprintID   uuid.UUID `json:"sprint_id"`
	SprintName string    `json:"sprint_name"`
	StartsOn   string    `json:"starts_on"`
	Planned    int       `json:"planned"`
	Completed  int       `json:"completed"`
}

// SprintClosedRow is issues closed against issues touched, per sprint.
type SprintClosedRow struct {
	SprintID   uuid.UUID `json:"sprint_id"`
	SprintName string    `json:"sprint_name"`
	StartsOn   string    `json:"starts_on"`
	Closed     int       `json:"closed"`
	Total      int       `json:"total"`
}

// StaleIssueRow is work that quietly stopped: open, assigned or not, and
// silent across every signal the system has.
type StaleIssueRow struct {
	ID            uuid.UUID `json:"id"`
	Key           string    `json:"key"`
	Title         string    `json:"title"`
	Status        string    `json:"status"`
	AssigneeLogin string    `json:"assignee_login"`
	MilestoneName string    `json:"milestone_name"`
	LastSignalAt  string    `json:"last_signal_at"`
	DaysSilent    int       `json:"days_silent"`
}

// PersonActivity counts activity per actor. from and to are optional
// YYYY-MM-DD bounds; empty means unbounded on that side.
func (s *Store) PersonActivity(ctx context.Context, workspaceID uuid.UUID, from, to string) ([]PersonActivityRow, error) {
	var fromPtr, toPtr *string
	if from != "" {
		fromPtr = &from
	}
	if to != "" {
		toPtr = &to
	}

	rows, err := s.pool.Query(ctx, `
		SELECT a.actor_id,
		       COALESCE(u.github_login, ''), COALESCE(u.name, ''),
		       a.verb, count(*)
		FROM activity a
		LEFT JOIN app_user u ON u.id = a.actor_id
		WHERE a.workspace_id = $1
		  AND ($2::date IS NULL OR a.created_at >= $2::date)
		  AND ($3::date IS NULL OR a.created_at < $3::date + interval '1 day')
		GROUP BY a.actor_id, u.github_login, u.name, a.verb`,
		workspaceID, fromPtr, toPtr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Fold the verb rows into one row per person, keeping first-seen order
	// stable before the final sort by total.
	byActor := map[string]*PersonActivityRow{}
	order := []*PersonActivityRow{}
	for rows.Next() {
		var actorID *uuid.UUID
		var login, name, verb string
		var count int
		if err := rows.Scan(&actorID, &login, &name, &verb, &count); err != nil {
			return nil, err
		}
		key := "system"
		if actorID != nil {
			key = actorID.String()
		}
		row, ok := byActor[key]
		if !ok {
			row = &PersonActivityRow{
				UserID: actorID, GitHubLogin: login, Name: name,
				Verbs: map[string]int{},
			}
			byActor[key] = row
			order = append(order, row)
		}
		row.Verbs[verb] += count
		row.Total += count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]PersonActivityRow, 0, len(order))
	for _, row := range order {
		out = append(out, *row)
	}
	sortDesc(out, func(r PersonActivityRow) int { return r.Total })
	return out, nil
}

// MilestoneCompletion is the completion rate per sprint. Cancelled milestones
// count as neither planned nor completed: work that was called off never
// belonged in the denominator.
func (s *Store) MilestoneCompletion(ctx context.Context, workspaceID uuid.UUID) ([]MilestoneCompletionRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT s.id, s.name, to_char(s.starts_on, 'YYYY-MM-DD'),
		       count(m.id) FILTER (WHERE m.status <> 'cancelled'),
		       count(m.id) FILTER (WHERE m.status = 'completed')
		FROM sprint s
		LEFT JOIN milestone m ON m.sprint_id = s.id AND m.workspace_id = s.workspace_id
		WHERE s.workspace_id = $1
		GROUP BY s.id, s.name, s.starts_on
		ORDER BY s.starts_on DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []MilestoneCompletionRow{}
	for rows.Next() {
		var r MilestoneCompletionRow
		if err := rows.Scan(&r.SprintID, &r.SprintName, &r.StartsOn,
			&r.Planned, &r.Completed); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// IssuesClosedPerSprint counts done issues against all issues filed under the
// sprint's milestones.
func (s *Store) IssuesClosedPerSprint(ctx context.Context, workspaceID uuid.UUID) ([]SprintClosedRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT s.id, s.name, to_char(s.starts_on, 'YYYY-MM-DD'),
		       count(i.id) FILTER (WHERE i.status = 'done'),
		       count(i.id)
		FROM sprint s
		LEFT JOIN milestone m ON m.sprint_id = s.id AND m.workspace_id = s.workspace_id
		LEFT JOIN issue i ON i.milestone_id = m.id AND i.workspace_id = s.workspace_id
		WHERE s.workspace_id = $1
		GROUP BY s.id, s.name, s.starts_on
		ORDER BY s.starts_on DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SprintClosedRow{}
	for rows.Next() {
		var r SprintClosedRow
		if err := rows.Scan(&r.SprintID, &r.SprintName, &r.StartsOn,
			&r.Closed, &r.Total); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// StaleIssues finds unfinished work whose newest signal is older than days.
//
// The signal is the newest of three things: the issue row's own updated_at,
// the newest activity row about it, and the newest linked pull request's
// gh_updated_at. Taking the newest of the three is what keeps the report
// honest - an issue with a PR pushed yesterday is not stalled just because
// nobody commented on it - and it is why the report is worth trusting when it
// does flag something.
//
// Finished work is never stale: a done or cancelled issue has stopped on
// purpose.
func (s *Store) StaleIssues(ctx context.Context, workspaceID uuid.UUID, days int) ([]StaleIssueRow, error) {
	rows, err := s.pool.Query(ctx, `
		WITH signal AS (
			SELECT i.id,
			       GREATEST(
			           i.updated_at,
			           COALESCE((SELECT max(a.created_at) FROM activity a
			                     WHERE a.workspace_id = i.workspace_id
			                       AND a.target_type = 'issue' AND a.target_id = i.id),
			                    i.updated_at),
			           COALESCE((SELECT max(p.gh_updated_at) FROM pr_link l
			                     JOIN pull_request p ON p.id = l.pull_request_id
			                     WHERE l.issue_id = i.id AND l.workspace_id = i.workspace_id),
			                    i.updated_at)
			       ) AS last_signal_at
			FROM issue i
			WHERE i.workspace_id = $1
			  AND i.status NOT IN ('done', 'cancelled')
		)
		SELECT i.id, i.key, i.title, i.status::text,
		       COALESCE(u.github_login, ''), COALESCE(m.name, ''),
		       to_char(g.last_signal_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       EXTRACT(day FROM now() - g.last_signal_at)::int
		FROM issue i
		JOIN signal g ON g.id = i.id
		LEFT JOIN app_user u ON u.id = i.assignee_id
		LEFT JOIN milestone m ON m.id = i.milestone_id
		WHERE i.workspace_id = $1
		  AND g.last_signal_at < now() - make_interval(days => $2)
		ORDER BY g.last_signal_at ASC`, workspaceID, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []StaleIssueRow{}
	for rows.Next() {
		var r StaleIssueRow
		if err := rows.Scan(&r.ID, &r.Key, &r.Title, &r.Status,
			&r.AssigneeLogin, &r.MilestoneName, &r.LastSignalAt, &r.DaysSilent); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// sortDesc is an insertion sort on a small slice, stable so that equal totals
// keep the order the database returned rather than shuffling between requests.
func sortDesc[T any](rows []T, key func(T) int) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && key(rows[j]) > key(rows[j-1]); j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
}
