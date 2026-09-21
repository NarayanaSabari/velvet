package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// An agent that finds no issue key must still be able to record what it did.
// Before projects became a comment target the only honest option was to write
// nothing, which is the exact failure this product exists to prevent.
func TestAnAgentCanLogWorkAgainstAProjectWithNoTicket(t *testing.T) {
	f := testutil.NewFixture(t)
	project := createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	token := f.AgentToken("coding agent")

	rec := f.DoAsAgent(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments", token,
		map[string]any{"body": "I fixed token authentication.", "kind": "progress"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var comment store.Comment
	f.DecodeInto(rec, &comment)
	require.Equal(t, "project", comment.TargetType)
	require.Equal(t, project.ID, comment.TargetID)
	require.Equal(t, "agent", comment.Source)
	require.NotNil(t, comment.Kind)
	require.Equal(t, "progress", *comment.Kind)

	// The entry names the token that wrote it, so a record of work can be
	// traced back to the agent that produced it.
	var tokenName string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT t.name FROM comment c JOIN api_token t ON t.id = c.api_token_id WHERE c.id = $1`,
		comment.ID).Scan(&tokenName))
	require.Equal(t, "coding agent", tokenName)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/projects/velvet/comments", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var list struct {
		Comments []store.Comment `json:"comments"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Comments, 1)
	require.Equal(t, comment.ID, list.Comments[0].ID)
}

// Source must come from how the request authenticated, never from the body.
func TestCommentSourceIsDerivedFromAuthenticationAndCannotBeForged(t *testing.T) {
	f := testutil.NewFixture(t)
	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments",
		map[string]any{"body": "I wrote this myself."})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var human store.Comment
	f.DecodeInto(rec, &human)
	require.Equal(t, "human", human.Source, "a browser session writes as a human")
	require.Nil(t, human.Kind, "ordinary discussion is not a classified entry")

	// The field is not part of the accepted request shape at all, so a client
	// claiming to be something else is rejected rather than quietly believed.
	rec = f.Do(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments",
		map[string]any{"body": "Pretending.", "source": "agent"})
	require.Equal(t, http.StatusBadRequest, rec.Code,
		"source must not be settable by the client")

	var forged int
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT count(*) FROM comment WHERE source = 'agent'`).Scan(&forged))
	require.Zero(t, forged)
}

func TestAgentEntriesSurviveRevokingTheTokenThatWroteThem(t *testing.T) {
	f := testutil.NewFixture(t)
	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	token := f.AgentToken("temporary agent")

	rec := f.DoAsAgent(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments", token,
		map[string]any{"body": "Work that must outlive its token."})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var comment store.Comment
	f.DecodeInto(rec, &comment)

	tokens, err := f.Store.ListAPITokens(t.Context(), f.User.ID)
	require.NoError(t, err)
	require.NoError(t, f.Store.DeleteAPIToken(t.Context(), f.User.ID, tokens[0].ID))

	// Revoking a token must never delete the record of work it wrote down.
	var body string
	var tokenID *string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT body, api_token_id::text FROM comment WHERE id = $1`, comment.ID).
		Scan(&body, &tokenID))
	require.Equal(t, "Work that must outlive its token.", body)
	require.Nil(t, tokenID, "the reference is cleared but the entry stays")
}

func TestAnUnknownCommentKindIsRejected(t *testing.T) {
	f := testutil.NewFixture(t)
	createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments",
		map[string]any{"body": "Something.", "kind": "invented"})
	require.Equal(t, http.StatusBadRequest, rec.Code)

	for _, kind := range []string{"progress", "decision", "blocker", "note"} {
		rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments",
			map[string]any{"body": "A " + kind + " entry.", "kind": kind})
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	}
}

func TestProjectCommentsCannotCrossAWorkspaceBoundary(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.CreateForeignProject(t, f, "foreign")

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/projects/foreign/comments",
		map[string]any{"body": "Logged into the wrong organisation."})
	require.Equal(t, http.StatusNotFound, rec.Code,
		"another workspace's project must not be loggable here")
}

func TestPromotingAProjectEntryCreatesALinkedTicket(t *testing.T) {
	f := testutil.NewFixture(t)
	project := createProject(t, f, map[string]any{"key": "velvet", "name": "Velvet"})
	token := f.AgentToken("coding agent")

	rec := f.DoAsAgent(http.MethodPost, "/api/v1/w/lab/projects/velvet/comments", token,
		map[string]any{"body": "Token refresh silently drops the retry.", "kind": "blocker"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var entry store.Comment
	f.DecodeInto(rec, &entry)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/comments/"+entry.ID.String()+"/promote",
		map[string]any{"title": "Fix the dropped retry"})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var issue store.Issue
	f.DecodeInto(rec, &issue)
	require.Equal(t, "Fix the dropped retry", issue.Title)
	require.Equal(t, "todo", issue.Status, "a promoted entry is work someone picked up")
	require.NotNil(t, issue.ProjectID)
	require.Equal(t, project.ID, *issue.ProjectID,
		"the ticket inherits the project the entry was logged against")
	require.Equal(t, "Token refresh silently drops the retry.", issue.Description)

	// The original entry stays and points at what it became, because it is the
	// record of when the work was actually noted.
	var body string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT body FROM comment WHERE id = $1`, entry.ID).Scan(&body))
	require.Contains(t, body, "Promoted to "+issue.Key)

	var verb string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`SELECT verb FROM activity WHERE verb = $1`, store.VerbPromotedEntry).Scan(&verb))
	require.Equal(t, store.VerbPromotedEntry, verb)
}

func TestOnlyAProjectEntryCanBePromoted(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Already a ticket"})

	rec := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
		map[string]any{"body": "A comment on work that already has a ticket."})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var comment store.Comment
	f.DecodeInto(rec, &comment)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/comments/"+comment.ID.String()+"/promote",
		map[string]any{"title": "Duplicate"})
	require.Equal(t, http.StatusBadRequest, rec.Code,
		"promoting an issue comment would duplicate the work it describes")
}

// Existing rows predate the source column, so the default must classify them
// as human rather than leaving the record ambiguous.
func TestExistingCommentsDefaultToHumanAuthorship(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})

	_, err := f.Pool.Exec(t.Context(), `
		INSERT INTO comment (workspace_id, target_type, target_id, author_id, body)
		VALUES ($1, 'issue', $2, $3, 'Written before the column existed')`,
		f.WorkspaceID, issue.ID, f.User.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+issue.Key+"/comments", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var list struct {
		Comments []store.Comment `json:"comments"`
	}
	f.DecodeInto(rec, &list)
	require.Len(t, list.Comments, 1)
	require.Equal(t, "human", list.Comments[0].Source)
	require.Nil(t, list.Comments[0].Kind)
}
