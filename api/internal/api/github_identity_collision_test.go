package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

func TestScopedIdentityCannotStealAnotherMembersGlobalFallback(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	claimant, err := f.Store.UpsertUserByEmail(ctx, "claimant@example.com")
	require.NoError(t, err)
	_, err = f.Pool.Exec(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member')`, f.WorkspaceID, claimant.ID)
	require.NoError(t, err)
	repo := testutil.LinkRepo(t, f, 555, "acme", "widgets")
	pr := insertPR(t, f, f.WorkspaceID, repo.ID, 1, "sabari")
	require.Equal(t, f.User.ID, *pr.AuthorID)
	require.NoError(t, f.Store.UpsertReview(ctx, store.UpsertReviewInput{
		WorkspaceID: f.WorkspaceID, PullRequestID: pr.ID, GitHubID: 5001,
		ReviewerLogin: "sabari", State: "APPROVED", SubmittedAt: time.Now().UTC()}))
	for _, identity := range []store.GitHubIdentity{
		{ID: *f.User.GitHubID, Login: *f.User.GitHubLogin},
		{ID: *f.User.GitHubID, Login: "renamed-owner"},
		{ID: 99, Login: "SABARI"},
	} {
		err = f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, claimant.ID, identity)
		require.ErrorIs(t, err, store.ErrDuplicate)
	}
	var authorID, reviewerID string
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT author_id::text FROM pull_request WHERE id=$1`, pr.ID).Scan(&authorID))
	require.NoError(t, f.Pool.QueryRow(ctx, `SELECT reviewer_id::text FROM pr_review WHERE github_id=5001`).Scan(&reviewerID))
	require.Equal(t, f.User.ID.String(), authorID)
	require.Equal(t, f.User.ID.String(), reviewerID)
	_, err = f.Store.GitHubIdentityForMembership(ctx, f.WorkspaceID, claimant.ID)
	require.ErrorIs(t, err, store.ErrNotFound)

	// A global account hidden by an override is not effective in this org.
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, f.User.ID,
		store.GitHubIdentity{ID: 2002, Login: "owner-client"}))
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, claimant.ID,
		store.GitHubIdentity{ID: *f.User.GitHubID, Login: *f.User.GitHubLogin}))

	// Removing the owner's override succeeds but suppresses the occupied fallback.
	removed := f.Do(http.MethodDelete, "/api/v1/w/lab/me/github", nil)
	require.Equal(t, http.StatusNoContent, removed.Code, removed.Body.String())
	_, err = f.Store.GitHubIdentityForMembership(ctx, f.WorkspaceID, f.User.ID)
	require.ErrorIs(t, err, store.ErrNotFound)
	require.NoError(t, f.Store.UnlinkMembershipGitHubIdentity(ctx, f.WorkspaceID, claimant.ID))
	identity, err := f.Store.GitHubIdentityForMembership(ctx, f.WorkspaceID, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, "global", identity.Source)
}

func TestInviteAcceptanceNeverDependsOnGitHubFallbackAvailability(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := t.Context()
	ownerToken := f.Token
	joining, err := testutil.CreateLinkedUser(t, f.Store, store.GitHubIdentity{ID: 42, Login: "shared"})
	require.NoError(t, err)
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, f.User.ID,
		store.GitHubIdentity{ID: 42, Login: "shared"}))
	// Updating the existing scoped claim remains allowed despite its global owner.
	require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, f.User.ID,
		store.GitHubIdentity{ID: 42, Login: "shared"}))
	invite, _, err := f.Store.CreateInvite(ctx, f.WorkspaceID, f.User.ID, joining.Email, "member")
	require.NoError(t, err)
	f.Token, err = f.Store.CreateSession(ctx, joining.ID, time.Hour)
	require.NoError(t, err)
	accepted := f.Do(http.MethodPost, "/api/v1/me/invites/"+invite.ID.String()+"/accept", nil)
	require.Equal(t, http.StatusOK, accepted.Code, accepted.Body.String())
	identity := f.Do(http.MethodGet, "/api/v1/w/lab/me/github", nil)
	require.Equal(t, http.StatusOK, identity.Code, identity.Body.String())
	require.JSONEq(t, `{"identity":null}`, identity.Body.String())
	issue := createIssue(t, f, map[string]any{"title": "Joining is independent of GitHub"})
	comment := f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments", map[string]any{"body": "@shared please review"})
	require.Equal(t, http.StatusCreated, comment.Code, comment.Body.String())
	var mentionIDs []string
	rows, err := f.Pool.Query(ctx, `SELECT user_id::text FROM comment_mention`)
	require.NoError(t, err)
	for rows.Next() {
		var id string
		require.NoError(t, rows.Scan(&id))
		mentionIDs = append(mentionIDs, id)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	require.Equal(t, []string{f.User.ID.String()}, mentionIDs)
	members, err := f.Store.ListWorkspaceMembers(ctx, f.WorkspaceID)
	require.NoError(t, err)
	for _, member := range members {
		if member.ID == joining.ID {
			require.Nil(t, member.GitHubID)
			require.Nil(t, member.GitHubLogin)
		} else {
			require.Equal(t, int64(42), *member.GitHubID)
			require.Equal(t, "shared", *member.GitHubLogin)
		}
	}
	joiningToken := f.Token
	f.Token = ownerToken
	adminMembers := f.Do(http.MethodGet, "/api/v1/w/lab/memberships", nil)
	require.Equal(t, http.StatusOK, adminMembers.Code, adminMembers.Body.String())
	var adminBody struct {
		Memberships []store.WorkspaceMembership `json:"memberships"`
	}
	f.DecodeInto(adminMembers, &adminBody)
	for _, member := range adminBody.Memberships {
		if member.User.ID == joining.ID {
			require.Nil(t, member.User.GitHubID)
			require.Nil(t, member.User.GitHubLogin)
			updated := f.Do(http.MethodPatch, "/api/v1/w/lab/memberships/"+member.ID.String(), map[string]any{"role": "member"})
			require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
			var returned store.WorkspaceMembership
			f.DecodeInto(updated, &returned)
			require.Nil(t, returned.User.GitHubID)
			require.Nil(t, returned.User.GitHubLogin)
		} else {
			require.Equal(t, int64(42), *member.User.GitHubID)
			require.Equal(t, "shared", *member.User.GitHubLogin)
		}
	}
	f.Token = joiningToken
	repo := testutil.LinkRepo(t, f, 555, "acme", "widgets")
	pr := insertPR(t, f, f.WorkspaceID, repo.ID, 1, "shared")
	require.Equal(t, f.User.ID, *pr.AuthorID)
	require.NoError(t, f.Store.UpsertCommit(ctx, store.UpsertCommitInput{
		SHA: "1111111111111111111111111111111111111111", WorkspaceID: f.WorkspaceID,
		RepoID: repo.ID, Branch: "main", Message: "Shared work",
		AuthorLogin: "shared", CommittedAt: time.Now().UTC()}))
	require.Zero(t, kindsIn(recap(t, f, ""))["commit"])
	f.Token = ownerToken
	require.Equal(t, 1, kindsIn(recap(t, f, ""))["commit"])
	require.NoError(t, f.Store.UnlinkMembershipGitHubIdentity(ctx, f.WorkspaceID, f.User.ID))
	f.Token, err = f.Store.CreateSession(ctx, joining.ID, time.Hour)
	require.NoError(t, err)
	identity = f.Do(http.MethodGet, "/api/v1/w/lab/me/github", nil)
	require.Equal(t, http.StatusOK, identity.Code, identity.Body.String())
	require.Contains(t, identity.Body.String(), `"source":"global"`)
	require.Equal(t, 1, kindsIn(recap(t, f, ""))["commit"])
}

func TestGitHubOAuthRejectsEffectiveAccountCollision(t *testing.T) {
	for _, scope := range []string{"scoped", "global"} {
		t.Run(scope, func(t *testing.T) {
			f := testutil.NewFixture(t)
			ctx := t.Context()
			other, err := f.Store.UpsertUserByEmail(ctx, "other@example.com")
			require.NoError(t, err)
			_, err = f.Pool.Exec(ctx, `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member')`, f.WorkspaceID, other.ID)
			require.NoError(t, err)
			path := "/api/v1/auth/github/link"
			if scope == "scoped" {
				_, err = f.Pool.Exec(ctx, `UPDATE app_user SET github_id=42,github_login='linked-owner' WHERE id=$1`, other.ID)
				require.NoError(t, err)
				path = "/api/v1/w/lab/me/github/link"
			} else {
				require.NoError(t, f.Store.LinkMembershipGitHubIdentity(ctx, f.WorkspaceID, other.ID,
					store.GitHubIdentity{ID: 42, Login: "linked-owner"}))
			}
			stub := newGitHubAuthStub(t)
			h := api.NewServer(f.Pool, &config.Config{BaseURL: "http://localhost:8080"}, api.Dependencies{GitHubUser: stub.client}).Handler()
			start := githubRequest(h, http.MethodGet, path, f.Token)
			require.Equal(t, http.StatusFound, start.Code, start.Body.String())
			callback := githubCallback(t, start.Header().Get("Location"))
			done := githubRequest(h, http.MethodGet, callback, f.Token)
			require.Equal(t, http.StatusConflict, done.Code, done.Body.String())
			user, err := f.Store.UserBySessionToken(ctx, f.Token)
			require.NoError(t, err)
			require.Equal(t, f.User.GitHubID, user.GitHubID)
			identity, err := f.Store.GitHubIdentityForMembership(ctx, f.WorkspaceID, f.User.ID)
			require.NoError(t, err)
			require.Equal(t, "global", identity.Source)
			require.Equal(t, *f.User.GitHubID, identity.GitHubID)
			var completed bool
			require.NoError(t, f.Pool.QueryRow(ctx, `SELECT completed_at IS NOT NULL FROM github_authorization_state`).Scan(&completed))
			require.False(t, completed)
		})
	}
}
