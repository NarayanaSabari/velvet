package store

import (
	"context"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	VerbCommented          = "commented"
	VerbCreatedIssue       = "created_issue"
	VerbChangedStatus      = "changed_status"
	VerbAssigned           = "assigned"
	VerbAttachedPR         = "attached_pr"
	VerbCompletedMilestone = "completed_milestone"
	VerbCreatedMilestone   = "created_milestone"
	VerbClosedSprint       = "closed_sprint"
	VerbCreatedSprint      = "created_sprint"
	VerbActivatedSprint    = "activated_sprint"
	VerbInvitedMember      = "invited_member"
	VerbChangedMemberRole  = "changed_member_role"
	VerbCreatedProject     = "created_project"
	VerbUpdatedProject     = "updated_project"
	VerbMappedRepoProject  = "mapped_repo_project"
	VerbMovedIssueProject  = "moved_issue_project"
	VerbPromotedEntry      = "promoted_entry"
	VerbAttachedCommit     = "attached_commit"
	// The GitHub account a person uses inside one organisation, which may
	// differ from the one they use elsewhere.
	VerbLinkedGitHubIdentity   = "linked_github_identity"
	VerbUnlinkedGitHubIdentity = "unlinked_github_identity"
)

type ActivityInput struct {
	WorkspaceID uuid.UUID
	ActorID     uuid.UUID
	Verb        string
	TargetType  string
	TargetID    uuid.UUID
	Metadata    map[string]any
}

type Activity struct {
	ID          int64          `json:"id"`
	WorkspaceID uuid.UUID      `json:"workspace_id"`
	Actor       *User          `json:"actor"`
	Verb        string         `json:"verb"`
	TargetType  string         `json:"target_type"`
	TargetID    uuid.UUID      `json:"target_id"`
	Metadata    map[string]any `json:"metadata"`
	CreatedAt   string         `json:"created_at"`
}

// RecordActivity must be called with the same tx as the change it describes,
// so the feed can never disagree with the underlying data.
//
// A zero ActorID stores NULL rather than a zero UUID, because some activity
// has no human actor: a webhook attaching a PR is the system reporting what
// GitHub said, not a person acting.
func RecordActivity(ctx context.Context, tx pgx.Tx, a ActivityInput) error {
	meta := a.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	var actor *uuid.UUID
	if a.ActorID != uuid.Nil {
		actor = &a.ActorID
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO activity (workspace_id, actor_id, verb, target_type, target_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		a.WorkspaceID, actor, a.Verb, a.TargetType, a.TargetID, meta)
	if err != nil {
		return fmt.Errorf("record activity %s: %w", a.Verb, err)
	}
	return nil
}

// NextIssueKey allocates the next per-workspace issue number. The UPDATE takes
// a row lock, so two concurrent creators serialise rather than collide.
func (s *Store) NextIssueKey(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID) (string, int64, error) {
	var prefix string
	var number int64
	err := tx.QueryRow(ctx, `
		UPDATE workspace SET issue_counter = issue_counter + 1
		WHERE id = $1
		RETURNING issue_prefix, issue_counter`, workspaceID).Scan(&prefix, &number)
	if err != nil {
		return "", 0, mapErr(err)
	}
	return fmt.Sprintf("%s-%d", prefix, number), number, nil
}

// ActivityFilter narrows the feed. An empty filter is the whole workspace.
type ActivityFilter struct {
	ActorID    *uuid.UUID
	Verbs      []string
	TargetType string
	TargetID   *uuid.UUID
	Cursor     string
	Limit      int
}

const (
	defaultActivityLimit = 30
	maxActivityLimit     = 100
	dashboardFeedLimit   = 20
)

// DashboardPayload is everything the personal dashboard needs in one request,
// so the first paint is a single round trip.
type DashboardPayload struct {
	Activity       []Activity `json:"activity"`
	MyIssues       []Issue    `json:"my_issues"`
	UnreadMentions int        `json:"unread_mentions"`
	// ActiveSprints holds every project's active sprint, since each project
	// runs its own. ActiveSprint and Milestones remain for older clients and
	// describe the first of them.
	ActiveSprints []ActiveSprint `json:"active_sprints"`
	ActiveSprint  *Sprint        `json:"active_sprint"`
	Milestones    []Milestone    `json:"milestones"`
}

// ActiveSprint is one project's running sprint and the milestones in it.
type ActiveSprint struct {
	Sprint      Sprint      `json:"sprint"`
	ProjectKey  string      `json:"project_key"`
	ProjectName string      `json:"project_name"`
	Milestones  []Milestone `json:"milestones"`
}

// ListActivity pages descending on the primary key, which is monotonic and
// therefore a stable cursor even when two rows share a timestamp.
func (s *Store) ListActivity(ctx context.Context, workspaceID uuid.UUID, f ActivityFilter) ([]Activity, string, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = defaultActivityLimit
	}
	if limit > maxActivityLimit {
		limit = maxActivityLimit
	}

	var before *int64
	if f.Cursor != "" {
		id, err := strconv.ParseInt(f.Cursor, 10, 64)
		if err != nil {
			return nil, "", fmt.Errorf("%w: cursor is not valid", ErrInvalidCursor)
		}
		before = &id
	}

	var verbs []string
	if len(f.Verbs) > 0 {
		verbs = f.Verbs
	}
	var targetType *string
	if f.TargetType != "" {
		targetType = &f.TargetType
	}

	rows, err := s.pool.Query(ctx, `
		SELECT a.id, a.workspace_id, a.verb, a.target_type, a.target_id, a.metadata,
		       to_char(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
		       u.id, u.email, u.github_id, u.github_login, u.name, u.avatar_url
		FROM activity a
		LEFT JOIN app_user u ON u.id = a.actor_id
		WHERE a.workspace_id = $1
		  AND ($2::uuid IS NULL OR a.actor_id = $2)
		  AND ($3::text[] IS NULL OR a.verb = ANY($3))
		  AND ($4::text IS NULL OR a.target_type = $4)
		  AND ($5::uuid IS NULL OR a.target_id = $5)
		  AND ($6::bigint IS NULL OR a.id < $6)
		ORDER BY a.id DESC
		LIMIT $7`,
		workspaceID, f.ActorID, verbs, targetType, f.TargetID, before, limit)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	out := []Activity{}
	for rows.Next() {
		var a Activity
		var actorID *uuid.UUID
		var githubID *int64
		var email, login, name, avatar *string
		if err := rows.Scan(&a.ID, &a.WorkspaceID, &a.Verb, &a.TargetType, &a.TargetID,
			&a.Metadata, &a.CreatedAt,
			&actorID, &email, &githubID, &login, &name, &avatar); err != nil {
			return nil, "", err
		}
		// The actor is nullable because a departed user's history stays in the
		// feed even after their account is removed.
		if actorID != nil {
			u := User{ID: *actorID, GitHubID: githubID, GitHubLogin: login}
			if email != nil {
				u.Email = *email
			}
			if name != nil {
				u.Name = *name
			}
			if avatar != nil {
				u.AvatarURL = *avatar
			}
			a.Actor = &u
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}

	// A short page is the last page, so it carries no cursor and the client
	// stops rather than making one more empty round trip.
	next := ""
	if len(out) == limit {
		next = strconv.FormatInt(out[len(out)-1].ID, 10)
	}
	return out, next, nil
}

// LatestActivityID is the watermark a handler captures before a mutation, so
// it can publish exactly the rows that mutation wrote.
func (s *Store) LatestActivityID(ctx context.Context, workspaceID uuid.UUID) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`SELECT COALESCE(max(id), 0) FROM activity WHERE workspace_id = $1`, workspaceID).Scan(&id)
	return id, err
}

// Dashboard gathers the personal view. The reads run sequentially: at this
// scale the round trips are cheap, and one connection keeps the numbers
// consistent with each other.
func (s *Store) Dashboard(ctx context.Context, workspaceID, userID uuid.UUID) (DashboardPayload, error) {
	var out DashboardPayload

	activity, _, err := s.ListActivity(ctx, workspaceID, ActivityFilter{Limit: dashboardFeedLimit})
	if err != nil {
		return out, err
	}
	out.Activity = activity

	issues, _, err := s.ListIssues(ctx, workspaceID, IssueFilter{
		AssigneeID: &userID,
		Statuses:   []string{"backlog", "todo", "in_progress", "in_review"},
	})
	if err != nil {
		return out, err
	}
	out.MyIssues = issues

	if out.UnreadMentions, err = s.UnreadMentionCount(ctx, workspaceID, userID); err != nil {
		return out, err
	}

	// Each project runs its own sprint, so every running one is listed,
	// ordered by project name for a stable dashboard.
	rows, err := s.pool.Query(ctx, `
		SELECT s.id, s.workspace_id, s.project_id, s.name,
		       to_char(s.starts_on, 'YYYY-MM-DD'), to_char(s.ends_on, 'YYYY-MM-DD'),
		       s.state::text, to_char(s.created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
		       to_char(s.completed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
		       p.key, p.name
		FROM sprint s JOIN project p ON p.id = s.project_id
		WHERE s.workspace_id = $1 AND s.state = 'active'
		ORDER BY lower(p.name), p.id`, workspaceID)
	if err != nil {
		return out, err
	}
	var active []ActiveSprint
	for rows.Next() {
		var a ActiveSprint
		if err := rows.Scan(&a.Sprint.ID, &a.Sprint.WorkspaceID, &a.Sprint.ProjectID, &a.Sprint.Name,
			&a.Sprint.StartsOn, &a.Sprint.EndsOn, &a.Sprint.State, &a.Sprint.CreatedAt, &a.Sprint.CompletedAt,
			&a.ProjectKey, &a.ProjectName); err != nil {
			rows.Close()
			return out, err
		}
		active = append(active, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	out.ActiveSprints = []ActiveSprint{}
	out.Milestones = []Milestone{}
	for i := range active {
		if active[i].Milestones, err = s.ListMilestonesForSprint(ctx, workspaceID, active[i].Sprint.ID); err != nil {
			return out, err
		}
	}
	// No active sprint is a normal state between sprints, not a failure.
	if len(active) > 0 {
		out.ActiveSprints = active
		out.ActiveSprint = &active[0].Sprint
		out.Milestones = active[0].Milestones
	}
	return out, nil
}
