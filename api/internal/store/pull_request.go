package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// PullRequest is the mirrored state of one GitHub pull request. It is the
// single PR type across the store, the worker, and the API, so an evidence
// card and a reconciler are always talking about the same shape.
type PullRequest struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspace_id"`
	RepoID      uuid.UUID  `json:"repo_id"`
	Number      int        `json:"number"`
	Title       string     `json:"title"`
	State       string     `json:"state"`
	Draft       bool       `json:"draft"`
	AuthorLogin string     `json:"author_login"`
	AuthorID    *uuid.UUID `json:"author_id"`
	HeadRef     string     `json:"head_ref"`
	Body        string     `json:"body"`
	Additions   int        `json:"additions"`
	Deletions   int        `json:"deletions"`
	HTMLURL     string     `json:"html_url"`
	MergedAt    *time.Time `json:"merged_at"`
	ClosedAt    *time.Time `json:"closed_at"`
	GHCreatedAt *time.Time `json:"gh_created_at"`
	GHUpdatedAt *time.Time `json:"gh_updated_at"`
}

// UpsertPRInput is one PR as GitHub reported it, from a webhook payload or
// from the REST API. Both paths converge here so the two can never disagree.
type UpsertPRInput struct {
	WorkspaceID uuid.UUID
	RepoID      uuid.UUID
	Number      int
	Title       string
	State       string
	Draft       bool
	AuthorLogin string
	HeadRef     string
	Body        string
	Additions   int
	Deletions   int
	HTMLURL     string
	MergedAt    *time.Time
	ClosedAt    *time.Time
	GHCreatedAt *time.Time
	GHUpdatedAt *time.Time
}

// Review is one mirrored review, so the record credits reviewers and not only
// authors.
type Review struct {
	ID            uuid.UUID `json:"id"`
	PullRequestID uuid.UUID `json:"pull_request_id"`
	GitHubID      int64     `json:"github_id"`
	ReviewerLogin string    `json:"reviewer_login"`
	State         string    `json:"state"`
	SubmittedAt   time.Time `json:"submitted_at"`
}

// Commit is one commit mirrored onto an issue timeline.
type Commit struct {
	SHA         string     `json:"sha"`
	IssueID     *uuid.UUID `json:"issue_id"`
	Branch      string     `json:"branch"`
	Message     string     `json:"message"`
	AuthorLogin string     `json:"author_login"`
	HTMLURL     string     `json:"html_url"`
	CommittedAt time.Time  `json:"committed_at"`
}

// Evidence is everything an issue page shows as proof of work. It is evidence
// only: nothing here has ever changed the issue's status.
type Evidence struct {
	PullRequests []PullRequest `json:"pull_requests"`
	Reviews      []Review      `json:"reviews"`
	Commits      []Commit      `json:"commits"`
}

// Repo is a linked GitHub repository.
type Repo struct {
	ID             uuid.UUID  `json:"id"`
	WorkspaceID    uuid.UUID  `json:"workspace_id"`
	InstallationID int64      `json:"installation_id"`
	GitHubID       int64      `json:"github_id"`
	Owner          string     `json:"owner"`
	Name           string     `json:"name"`
	DefaultBranch  string     `json:"default_branch"`
	SyncedAt       *time.Time `json:"synced_at"`
}

const prCols = `id, workspace_id, repo_id, number, title, state::text, draft,
	author_login, author_id, head_ref, body, additions, deletions, html_url,
	merged_at, closed_at, gh_created_at, gh_updated_at`

func scanPR(row pgx.Row) (PullRequest, error) {
	var p PullRequest
	err := row.Scan(&p.ID, &p.WorkspaceID, &p.RepoID, &p.Number, &p.Title, &p.State,
		&p.Draft, &p.AuthorLogin, &p.AuthorID, &p.HeadRef, &p.Body, &p.Additions,
		&p.Deletions, &p.HTMLURL, &p.MergedAt, &p.ClosedAt, &p.GHCreatedAt, &p.GHUpdatedAt)
	return p, mapErr(err)
}

// UpsertPullRequest mirrors one PR, refusing to apply an event older than the
// state already stored. GitHub delivers out of order after a retry, and
// without this guard a late "opened" event would un-merge a merged PR.
func (s *Store) UpsertPullRequest(ctx context.Context, in UpsertPRInput) (PullRequest, error) {
	pr, err := scanPR(s.pool.QueryRow(ctx, `
		INSERT INTO pull_request (workspace_id, repo_id, number, title, state, draft,
			author_login, head_ref, body, additions, deletions, html_url,
			merged_at, closed_at, gh_created_at, gh_updated_at,
			author_id)
		VALUES ($1, $2, $3, $4, $5::pr_state, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
			(SELECT u.id FROM app_user u
			 JOIN membership m ON m.user_id = u.id AND m.workspace_id = $1
			 WHERE u.github_login = $7))
		ON CONFLICT (repo_id, number) DO UPDATE SET
			title = EXCLUDED.title, state = EXCLUDED.state, draft = EXCLUDED.draft,
			body = EXCLUDED.body, additions = EXCLUDED.additions,
			deletions = EXCLUDED.deletions, merged_at = EXCLUDED.merged_at,
			closed_at = EXCLUDED.closed_at, head_ref = EXCLUDED.head_ref,
			author_login = EXCLUDED.author_login, author_id = EXCLUDED.author_id,
			html_url = EXCLUDED.html_url,
			gh_updated_at = EXCLUDED.gh_updated_at, updated_at = now()
		WHERE EXCLUDED.gh_updated_at >= pull_request.gh_updated_at
		RETURNING `+prCols,
		in.WorkspaceID, in.RepoID, in.Number, in.Title, in.State, in.Draft,
		in.AuthorLogin, in.HeadRef, in.Body, in.Additions, in.Deletions, in.HTMLURL,
		in.MergedAt, in.ClosedAt, in.GHCreatedAt, in.GHUpdatedAt))
	if err == nil {
		return pr, nil
	}
	if err != ErrNotFound {
		return PullRequest{}, err
	}
	// A skipped update returns no row. That is the stale-event case, not a
	// failure: re-read what is stored and let the caller carry on.
	return scanPR(s.pool.QueryRow(ctx,
		`SELECT `+prCols+` FROM pull_request WHERE repo_id = $1 AND number = $2`,
		in.RepoID, in.Number))
}

// LinkPR attaches a PR to an issue as evidence and reports whether the link
// was new. Activity is recorded only for a new link, in the same transaction,
// so a redelivered event cannot re-announce an attachment that already
// happened.
//
// It never touches issue.status. A PR is proof of work, not a controller of
// it; the decision that an issue is done belongs to a person.
func (s *Store) LinkPR(ctx context.Context, workspaceID, prID, issueID uuid.UUID, source string, closing bool, actorID *uuid.UUID) (bool, error) {
	created := false
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			INSERT INTO pr_link (workspace_id, pull_request_id, issue_id, link_source, closing)
			VALUES ($1, $2, $3, $4::pr_link_source, $5)
			ON CONFLICT (pull_request_id, issue_id) DO NOTHING`,
			workspaceID, prID, issueID, source, closing)
		if err != nil {
			return mapErr(err)
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		created = true

		var number int
		var url string
		if err := tx.QueryRow(ctx,
			`SELECT number, html_url FROM pull_request WHERE id = $1`, prID).
			Scan(&number, &url); err != nil {
			return mapErr(err)
		}

		var actor uuid.UUID
		if actorID != nil {
			actor = *actorID
		}
		return RecordActivity(ctx, tx, ActivityInput{
			WorkspaceID: workspaceID, ActorID: actor,
			Verb: VerbAttachedPR, TargetType: "issue", TargetID: issueID,
			Metadata: map[string]any{
				"pull_request_id": prID.String(),
				"number":          number,
				"html_url":        url,
				"source":          source,
				"closing":         closing,
			},
		})
	})
	return created, err
}

// ManualLink is a human attaching a PR from the issue page. It verifies the PR
// belongs to the caller's workspace, so a valid UUID from another workspace
// cannot be smuggled onto an issue.
func (s *Store) ManualLink(ctx context.Context, workspaceID, issueID, prID, actorID uuid.UUID) error {
	var owner uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT workspace_id FROM pull_request WHERE id = $1`, prID).Scan(&owner)
	if err != nil {
		return mapErr(err)
	}
	if owner != workspaceID {
		return ErrForeignReference
	}
	var issueExists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM issue WHERE id = $1 AND workspace_id = $2)`,
		issueID, workspaceID).Scan(&issueExists); err != nil {
		return err
	}
	if !issueExists {
		return ErrNotFound
	}
	_, err = s.LinkPR(ctx, workspaceID, prID, issueID, "manual", false, &actorID)
	return err
}

// Unlink removes an evidence link. The PR itself stays stored, so unlinking a
// mistake does not lose the record of the work.
func (s *Store) Unlink(ctx context.Context, workspaceID, issueID, prID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM pr_link
		WHERE workspace_id = $1 AND issue_id = $2 AND pull_request_id = $3`,
		workspaceID, issueID, prID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// IssueIDByKey resolves a key like ENG-1 within one workspace.
func (s *Store) IssueIDByKey(ctx context.Context, workspaceID uuid.UUID, key string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM issue WHERE workspace_id = $1 AND key = $2`, workspaceID, key).Scan(&id)
	return id, mapErr(err)
}

// UnlinkedPullRequests lists PRs that matched no issue. Dropping unmatched
// work silently is how a team stops trusting the tool, so the gap stays
// visible and one click closes it.
func (s *Store) UnlinkedPullRequests(ctx context.Context, workspaceID uuid.UUID, limit int) ([]PullRequest, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+prCols+`
		FROM pull_request p
		WHERE p.workspace_id = $1
		  AND NOT EXISTS (SELECT 1 FROM pr_link l WHERE l.pull_request_id = p.id)
		ORDER BY p.gh_updated_at DESC NULLS LAST, p.number DESC
		LIMIT $2`, workspaceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []PullRequest{}
	for rows.Next() {
		pr, err := scanPR(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, pr)
	}
	return out, rows.Err()
}

// EvidenceForIssue gathers every attached PR with its reviews and the commits
// pushed against the issue's branches.
func (s *Store) EvidenceForIssue(ctx context.Context, workspaceID, issueID uuid.UUID) (Evidence, error) {
	out := Evidence{PullRequests: []PullRequest{}, Reviews: []Review{}, Commits: []Commit{}}

	prRows, err := s.pool.Query(ctx, `
		SELECT `+prCols+`
		FROM pull_request p
		JOIN pr_link l ON l.pull_request_id = p.id
		WHERE p.workspace_id = $1 AND l.issue_id = $2
		ORDER BY p.number`, workspaceID, issueID)
	if err != nil {
		return out, err
	}
	defer prRows.Close()
	for prRows.Next() {
		pr, err := scanPR(prRows)
		if err != nil {
			return out, err
		}
		out.PullRequests = append(out.PullRequests, pr)
	}
	if err := prRows.Err(); err != nil {
		return out, err
	}

	revRows, err := s.pool.Query(ctx, `
		SELECT r.id, r.pull_request_id, r.github_id, r.reviewer_login, r.state, r.submitted_at
		FROM pr_review r
		JOIN pr_link l ON l.pull_request_id = r.pull_request_id
		WHERE r.workspace_id = $1 AND l.issue_id = $2
		ORDER BY r.submitted_at`, workspaceID, issueID)
	if err != nil {
		return out, err
	}
	defer revRows.Close()
	for revRows.Next() {
		var rv Review
		if err := revRows.Scan(&rv.ID, &rv.PullRequestID, &rv.GitHubID,
			&rv.ReviewerLogin, &rv.State, &rv.SubmittedAt); err != nil {
			return out, err
		}
		out.Reviews = append(out.Reviews, rv)
	}
	if err := revRows.Err(); err != nil {
		return out, err
	}

	comRows, err := s.pool.Query(ctx, `
		SELECT sha, issue_id, branch, message, author_login, html_url, committed_at
		FROM commit_ref
		WHERE workspace_id = $1 AND issue_id = $2
		ORDER BY committed_at DESC`, workspaceID, issueID)
	if err != nil {
		return out, err
	}
	defer comRows.Close()
	for comRows.Next() {
		var c Commit
		if err := comRows.Scan(&c.SHA, &c.IssueID, &c.Branch, &c.Message,
			&c.AuthorLogin, &c.HTMLURL, &c.CommittedAt); err != nil {
			return out, err
		}
		out.Commits = append(out.Commits, c)
	}
	return out, comRows.Err()
}

const repoCols = `id, workspace_id, installation_id, github_id, owner, name,
	default_branch, synced_at`

func scanRepo(row pgx.Row) (Repo, error) {
	var r Repo
	err := row.Scan(&r.ID, &r.WorkspaceID, &r.InstallationID, &r.GitHubID,
		&r.Owner, &r.Name, &r.DefaultBranch, &r.SyncedAt)
	return r, mapErr(err)
}

// RepoByGitHubID resolves the repository a delivery belongs to, which is also
// how a delivery is attributed to a workspace.
func (s *Store) RepoByGitHubID(ctx context.Context, githubID int64) (Repo, error) {
	return scanRepo(s.pool.QueryRow(ctx,
		`SELECT `+repoCols+` FROM repo WHERE github_id = $1`, githubID))
}

func (s *Store) ListRepos(ctx context.Context, workspaceID uuid.UUID) ([]Repo, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+repoCols+` FROM repo WHERE workspace_id = $1 ORDER BY owner, name`,
		workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Repo{}
	for rows.Next() {
		r, err := scanRepo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// LinkRepoInput onboards one repository into a workspace.
type LinkRepoInput struct {
	WorkspaceID    uuid.UUID
	InstallationID int64
	GitHubID       int64
	Owner          string
	Name           string
	DefaultBranch  string
}

// LinkRepo binds a repository to a workspace, creating the installation row
// when the App's installation event has not been seen yet.
func (s *Store) LinkRepo(ctx context.Context, in LinkRepoInput) (Repo, error) {
	if in.DefaultBranch == "" {
		in.DefaultBranch = "main"
	}
	var out Repo
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			INSERT INTO github_installation (id, account_login) VALUES ($1, $2)
			ON CONFLICT (id) DO NOTHING`, in.InstallationID, in.Owner); err != nil {
			return err
		}
		var err error
		out, err = scanRepo(tx.QueryRow(ctx, `
			INSERT INTO repo (workspace_id, installation_id, github_id, owner, name, default_branch)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (github_id) DO UPDATE SET
				owner = EXCLUDED.owner, name = EXCLUDED.name,
				default_branch = EXCLUDED.default_branch
			RETURNING `+repoCols,
			in.WorkspaceID, in.InstallationID, in.GitHubID, in.Owner, in.Name, in.DefaultBranch))
		return err
	})
	return out, err
}

// ReposDueForSync lists repositories whose last successful sync is older than
// olderThan, plus those never synced. Reconciliation is what makes a missed
// webhook survivable.
func (s *Store) ReposDueForSync(ctx context.Context, olderThan time.Duration) ([]Repo, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+repoCols+`
		FROM repo
		WHERE synced_at IS NULL OR synced_at < now() - $1::interval
		ORDER BY synced_at NULLS FIRST`, olderThan.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Repo{}
	for rows.Next() {
		r, err := scanRepo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// MarkRepoSynced stamps a successful sync. It is called only after a repo
// finishes, because stamping after a failure would silently skip the gap the
// failed run left behind.
func (s *Store) MarkRepoSynced(ctx context.Context, repoID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE repo SET synced_at = now() WHERE id = $1`, repoID)
	return err
}

// WorkspaceIssuePrefix returns the key prefix used for matching, e.g. ENG.
func (s *Store) WorkspaceIssuePrefix(ctx context.Context, workspaceID uuid.UUID) (string, error) {
	var prefix string
	err := s.pool.QueryRow(ctx,
		`SELECT issue_prefix FROM workspace WHERE id = $1`, workspaceID).Scan(&prefix)
	return prefix, mapErr(err)
}

// PullRequestIDByNumber resolves a stored PR within a repository.
func (s *Store) PullRequestIDByNumber(ctx context.Context, repoID uuid.UUID, number int) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM pull_request WHERE repo_id = $1 AND number = $2`, repoID, number).Scan(&id)
	return id, mapErr(err)
}

// UpsertReviewInput is one review as GitHub reported it.
type UpsertReviewInput struct {
	WorkspaceID   uuid.UUID
	PullRequestID uuid.UUID
	GitHubID      int64
	ReviewerLogin string
	State         string
	SubmittedAt   time.Time
}

// UpsertReview mirrors a review, keyed on GitHub's review id so a redelivery
// updates rather than duplicates.
func (s *Store) UpsertReview(ctx context.Context, in UpsertReviewInput) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO pr_review (workspace_id, pull_request_id, github_id,
			reviewer_login, reviewer_id, state, submitted_at)
		VALUES ($1, $2, $3, $4,
			(SELECT u.id FROM app_user u
			 JOIN membership m ON m.user_id = u.id AND m.workspace_id = $1
			 WHERE u.github_login = $4),
			$5, $6)
		ON CONFLICT (github_id) DO UPDATE SET
			state = EXCLUDED.state, submitted_at = EXCLUDED.submitted_at`,
		in.WorkspaceID, in.PullRequestID, in.GitHubID, in.ReviewerLogin,
		in.State, in.SubmittedAt)
	return err
}

// UpsertCommitInput is one commit from a push.
type UpsertCommitInput struct {
	SHA         string
	WorkspaceID uuid.UUID
	RepoID      uuid.UUID
	IssueID     *uuid.UUID
	Branch      string
	Message     string
	AuthorLogin string
	HTMLURL     string
	CommittedAt time.Time
}

// UpsertCommit records a commit once. A replayed push is a no-op, which is
// what keeps an issue timeline from growing duplicates after an outage.
func (s *Store) UpsertCommit(ctx context.Context, in UpsertCommitInput) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO commit_ref (sha, workspace_id, repo_id, issue_id, branch,
			message, author_login, html_url, committed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (sha) DO NOTHING`,
		in.SHA, in.WorkspaceID, in.RepoID, in.IssueID, in.Branch,
		in.Message, in.AuthorLogin, in.HTMLURL, in.CommittedAt)
	return err
}

// UpsertInstallation records a GitHub App installation.
func (s *Store) UpsertInstallation(ctx context.Context, id int64, accountLogin string, suspended bool) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO github_installation (id, account_login, suspended_at)
		VALUES ($1, $2, CASE WHEN $3 THEN now() END)
		ON CONFLICT (id) DO UPDATE SET
			account_login = EXCLUDED.account_login,
			suspended_at = CASE WHEN $3 THEN now() ELSE NULL END`,
		id, accountLogin, suspended)
	return err
}

// MarkDeliveryProcessed stamps a delivery as done, so the unprocessed index
// shows only real backlog.
func (s *Store) MarkDeliveryProcessed(ctx context.Context, deliveryID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE github_event SET processed_at = now() WHERE delivery_id = $1`, deliveryID)
	return err
}

// DeliveryPayload returns a stored delivery for the worker to process.
func (s *Store) DeliveryPayload(ctx context.Context, deliveryID string) (eventType string, payload []byte, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT event_type, payload FROM github_event WHERE delivery_id = $1`, deliveryID).
		Scan(&eventType, &payload)
	return eventType, payload, mapErr(err)
}
