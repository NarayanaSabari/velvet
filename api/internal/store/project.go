package store

import (
	"context"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Project is the durable unit of work inside an organisation. It outlives the
// sprints its issues are scheduled into, so "the thing I have been working on
// for three months" has one name that does not disappear when a month closes.
type Project struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspace_id"`
	Key         string     `json:"key"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Status      string     `json:"status"`
	CreatedBy   *uuid.UUID `json:"created_by"`
	CreatedAt   string     `json:"created_at"`
	UpdatedAt   string     `json:"updated_at"`
	ArchivedAt  *string    `json:"archived_at"`
	// IssueCounts is populated by list reads so the projects page can show
	// where work stands without a second round trip per row.
	IssueCounts map[string]int `json:"issue_counts,omitempty"`
}

type CreateProjectInput struct {
	WorkspaceID uuid.UUID
	ActorID     uuid.UUID
	Key         string
	Name        string
	Description string
}

// ProjectPatch leaves a nil field unchanged, matching MilestonePatch.
type ProjectPatch struct {
	Name        *string
	Description *string
	Status      *string
}

// projectKeyRe mirrors the database check constraint. Validating in both
// places means a bad key is a 400 from the handler rather than a 500 from a
// constraint violation, while the database still refuses to store one.
var projectKeyRe = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`)

func ValidProjectKey(key string) bool { return projectKeyRe.MatchString(key) }

func ValidProjectStatus(s string) bool { return s == "active" || s == "archived" }

// NormalizeProjectKey lowercases at the boundary so that "Velvet" and "velvet"
// name the same project, the same way issue keys normalize to uppercase.
func NormalizeProjectKey(key string) string {
	return strings.ToLower(strings.TrimSpace(key))
}

// projectCols is deliberately unaliased so the same list works in a plain
// SELECT, an INSERT ... RETURNING, and an UPDATE ... RETURNING.
const projectCols = `id, workspace_id, key, name, description, status::text,
	created_by,
	to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM'),
	to_char(archived_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:TZM')`

func scanProject(row pgx.Row) (Project, error) {
	var p Project
	err := row.Scan(&p.ID, &p.WorkspaceID, &p.Key, &p.Name, &p.Description,
		&p.Status, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt, &p.ArchivedAt)
	return p, mapErr(err)
}

func (s *Store) CreateProject(ctx context.Context, in CreateProjectInput) (Project, error) {
	var out Project
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		var err error
		// A zero actor stores NULL rather than a zero UUID, matching
		// RecordActivity: seed and system-created rows have no human author.
		var createdBy *uuid.UUID
		if in.ActorID != uuid.Nil {
			createdBy = &in.ActorID
		}
		out, err = scanProject(tx.QueryRow(ctx, `
			INSERT INTO project (workspace_id, key, name, description, created_by)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING `+projectCols,
			in.WorkspaceID, in.Key, in.Name, in.Description, createdBy))
		if err != nil {
			return err
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: in.WorkspaceID, ActorID: in.ActorID,
			Verb: VerbCreatedProject, TargetType: "project", TargetID: out.ID,
			Metadata: map[string]any{"key": out.Key, "name": out.Name},
		})
	})
	return out, err
}

// ListProjects returns issue counts per status in the same round trip, because
// a projects page that needs a second query per row is a page that gets slow
// exactly when someone has enough projects to need the page.
func (s *Store) ListProjects(ctx context.Context, workspaceID uuid.UUID, includeArchived bool) ([]Project, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+projectCols+`, counts.issue_status, counts.n
		FROM project
		LEFT JOIN LATERAL (
		    SELECT i.status::text AS issue_status, count(*) AS n
		    FROM issue i
		    WHERE i.workspace_id = project.workspace_id AND i.project_id = project.id
		    GROUP BY i.status
		) counts ON true
		WHERE project.workspace_id = $1
		  AND ($2::bool OR project.status = 'active')
		ORDER BY project.status, lower(project.name), project.id`, workspaceID, includeArchived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Project{}
	index := map[uuid.UUID]int{}
	for rows.Next() {
		var p Project
		var status *string
		var n *int
		if err := rows.Scan(&p.ID, &p.WorkspaceID, &p.Key, &p.Name, &p.Description,
			&p.Status, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt, &p.ArchivedAt,
			&status, &n); err != nil {
			return nil, err
		}
		i, seen := index[p.ID]
		if !seen {
			p.IssueCounts = map[string]int{}
			index[p.ID] = len(out)
			out = append(out, p)
			i = len(out) - 1
		}
		// A project with no issues yields one row with NULL counts from the
		// LEFT JOIN, which must stay an empty map rather than a phantom entry.
		if status != nil && n != nil {
			out[i].IssueCounts[*status] = *n
		}
	}
	return out, rows.Err()
}

func (s *Store) GetProjectByKey(ctx context.Context, workspaceID uuid.UUID, key string) (Project, error) {
	return scanProject(s.pool.QueryRow(ctx,
		`SELECT `+projectCols+` FROM project WHERE workspace_id = $1 AND key = $2`,
		workspaceID, key))
}

// ProjectIDByKey resolves a key for the callers that only need the identifier,
// so an agent can name a project without first fetching the whole row.
func (s *Store) ProjectIDByKey(ctx context.Context, workspaceID uuid.UUID, key string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM project WHERE workspace_id = $1 AND key = $2`,
		workspaceID, key).Scan(&id)
	return id, mapErr(err)
}

// UpdateProject applies a patch and records one activity row per real change,
// so re-sending an unchanged value does not fill the feed with no-ops.
func (s *Store) UpdateProject(ctx context.Context, workspaceID, id, actorID uuid.UUID, patch ProjectPatch) (Project, error) {
	var out Project
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		before, err := scanProject(tx.QueryRow(ctx,
			`SELECT `+projectCols+` FROM project
			 WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
			workspaceID, id))
		if err != nil {
			return err
		}

		name := before.Name
		if patch.Name != nil {
			name = *patch.Name
		}
		description := before.Description
		if patch.Description != nil {
			description = *patch.Description
		}
		status := before.Status
		if patch.Status != nil {
			status = *patch.Status
		}

		// archived_at is derived rather than client-supplied, so the check
		// constraint pairing status and timestamp can never be violated.
		out, err = scanProject(tx.QueryRow(ctx, `
			UPDATE project
			SET name = $3, description = $4, status = $5::project_status,
			    archived_at = CASE WHEN $5 = 'archived'
			                       THEN COALESCE(project.archived_at, now()) END,
			    updated_at = now()
			WHERE workspace_id = $1 AND id = $2
			RETURNING `+projectCols,
			workspaceID, id, name, description, status))
		if err != nil {
			return err
		}

		changes := map[string]any{}
		if patch.Name != nil && *patch.Name != before.Name {
			changes["name"] = map[string]any{"from": before.Name, "to": out.Name}
		}
		if patch.Description != nil && *patch.Description != before.Description {
			changes["description"] = true
		}
		if patch.Status != nil && *patch.Status != before.Status {
			changes["status"] = map[string]any{"from": before.Status, "to": out.Status}
		}
		if len(changes) == 0 {
			return nil
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID, ActorID: actorID,
			Verb: VerbUpdatedProject, TargetType: "project", TargetID: id,
			Metadata: map[string]any{"key": out.Key, "changes": changes},
		})
	})
	return out, err
}

// SetRepoProject maps a repository to a project so that a commit on a branch
// carrying no issue key can still be attributed. A nil project clears it.
func (s *Store) SetRepoProject(ctx context.Context, workspaceID, repoID, actorID uuid.UUID, projectID *uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if projectID != nil {
			if err := checkProjectInWorkspace(ctx, tx, workspaceID, *projectID); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(ctx,
			`UPDATE repo SET project_id = $3 WHERE workspace_id = $1 AND id = $2`,
			workspaceID, repoID, projectID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		meta := map[string]any{"repo_id": repoID.String(), "project_id": nil}
		if projectID != nil {
			meta["project_id"] = projectID.String()
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID, ActorID: actorID,
			Verb: VerbMappedRepoProject, TargetType: "repo", TargetID: repoID,
			Metadata: meta,
		})
	})
}

// checkProjectInWorkspace keeps a valid UUID from another workspace from being
// used as a project reference, matching checkIssueReferences.
func checkProjectInWorkspace(ctx context.Context, tx pgx.Tx, workspaceID, projectID uuid.UUID) error {
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM project WHERE id = $1 AND workspace_id = $2)`,
		projectID, workspaceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}
