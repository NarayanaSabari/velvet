package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

func legacyDatabase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	c, err := tcpostgres.Run(ctx, "postgres:18-alpine", tcpostgres.WithDatabase("upgrade"),
		tcpostgres.WithUsername("ticket"), tcpostgres.WithPassword("ticket"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(180*time.Second)))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, c.Terminate(context.Background())) })
	url, err := c.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	pool, err := Connect(ctx, url)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, `CREATE TABLE schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
	require.NoError(t, err)
	entries, err := migrationFS.ReadDir("migrations")
	require.NoError(t, err)
	for _, entry := range entries {
		if entry.Name() > "0005_organisations.sql" {
			continue
		}
		body, err := migrationFS.ReadFile("migrations/" + entry.Name())
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(body))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO schema_migration (name) VALUES ($1)`, entry.Name())
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO workspace (id,name,slug) VALUES ('00000000-0000-0000-0000-000000000001','Lab','lab'), ('00000000-0000-0000-0000-000000000002','Other','other');
		INSERT INTO app_user (id,email,github_id,github_login) VALUES ('00000000-0000-0000-0000-000000000003','owner@example.com',42,'owner');
		INSERT INTO membership (workspace_id,user_id,invited_login,role) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','owner','admin');
		INSERT INTO github_setup_state(token_hash,workspace_id,user_id,expires_at) VALUES ('legacy','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003',now()+interval '15 minutes');
		INSERT INTO github_installation (id,account_login) VALUES (99,'acme');
		INSERT INTO repo (workspace_id,installation_id,github_id,owner,name) VALUES ('00000000-0000-0000-0000-000000000001',99,100,'acme','widgets');`)
	require.NoError(t, err)
	return pool
}

func TestEmailIdentityUpgradePreservesEvidence(t *testing.T) {
	pool := legacyDatabase(t)
	ctx := t.Context()
	require.NoError(t, Migrate(ctx, pool))
	var owner string
	var verified *time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT workspace_id::text,ownership_verified_at FROM github_installation WHERE id=99`).Scan(&owner, &verified))
	require.Equal(t, "00000000-0000-0000-0000-000000000001", owner)
	require.Nil(t, verified)
	var legacyExpired bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT expires_at <= now() FROM github_setup_state WHERE token_hash='legacy'`).Scan(&legacyExpired))
	require.True(t, legacyExpired)
	_, err := pool.Exec(ctx, `
		INSERT INTO session(id,user_id,expires_at) VALUES (repeat('a',64),'00000000-0000-0000-0000-000000000003',now()+interval '1 day');
		INSERT INTO github_setup_state(token_hash,workspace_id,user_id,session_id,candidate_installation_id,phase,claimed_at,expires_at)
		VALUES(repeat('b',64),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003',repeat('a',64),123456,'authorization',now(),now()+interval '15 minutes');
		INSERT INTO github_authorization_state(token_hash,session_id,user_id,purpose,setup_token_hash,verifier,expires_at,claimed_at)
		VALUES(repeat('c',64),repeat('a',64),'00000000-0000-0000-0000-000000000003','installation',repeat('b',64),'private-pkce-verifier',now()+interval '15 minutes',now());
		UPDATE github_setup_state SET phase='completed',completed_at=now() WHERE token_hash=repeat('b',64);
		UPDATE github_authorization_state SET completed_at=now() WHERE token_hash=repeat('c',64)`)
	require.NoError(t, err, "candidate installation may not exist until verification")
	_, err = pool.Exec(ctx, `INSERT INTO github_authorization_state(token_hash,session_id,user_id,purpose,verifier,expires_at) VALUES('invalid','missing','00000000-0000-0000-0000-000000000003','link','verifier',now())`)
	require.Error(t, err, "state must reference an existing session")
	_, err = pool.Exec(ctx, `DELETE FROM session WHERE id=repeat('a',64)`)
	require.NoError(t, err)
	var states int
	require.NoError(t, pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM github_authorization_state)+(SELECT count(*) FROM github_setup_state WHERE token_hash <> 'legacy')`).Scan(&states))
	require.Zero(t, states)
	_, err = pool.Exec(ctx, `INSERT INTO app_user (github_id,github_login) VALUES (43,'legacy')`)
	require.Error(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO membership (workspace_id,user_id) SELECT workspace_id,user_id FROM membership`)
	require.Error(t, err)
	_, err = pool.Exec(ctx, `DELETE FROM app_user WHERE github_id=42`)
	require.NoError(t, err)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM membership`).Scan(&n))
	require.Zero(t, n)
	_, err = pool.Exec(ctx, `UPDATE github_installation SET deleted_at=now(),repos_synced_at=now(),sync_error='unavailable',sync_generation=sync_generation+1 WHERE id=99; UPDATE repo SET disconnected_at=now()`)
	require.NoError(t, err)
}

func TestEmailIdentityUpgradePreflightRollsBack(t *testing.T) {
	for _, tc := range []struct{ name, seed, want string }{
		{"missing email", `UPDATE app_user SET email=NULL`, "backfill app_user.email"},
		{"blank email", `UPDATE app_user SET email='  '`, "backfill app_user.email"},
		{"unclaimed membership", `UPDATE membership SET user_id=NULL`, "resolve unclaimed memberships"},
		{"ambiguous ownership", `INSERT INTO repo(workspace_id,installation_id,github_id,owner,name) VALUES ('00000000-0000-0000-0000-000000000002',99,101,'acme','other')`, "installation ownership"},
		{"conflicting ownership", `UPDATE github_installation SET workspace_id='00000000-0000-0000-0000-000000000002'`, "installation ownership"},
		{"multiple installations", `INSERT INTO github_installation(id,account_login,workspace_id) VALUES (100,'second','00000000-0000-0000-0000-000000000001')`, "installation ownership"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := legacyDatabase(t)
			_, err := pool.Exec(t.Context(), tc.seed)
			require.NoError(t, err)
			err = Migrate(t.Context(), pool)
			require.ErrorContains(t, err, tc.want)
			var n int
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM schema_migration WHERE name LIKE '0006%'`).Scan(&n))
			require.Zero(t, n)
			_, err = pool.Exec(t.Context(), `UPDATE membership SET invited_login='still-legacy'`)
			require.NoError(t, err)
		})
	}
}
