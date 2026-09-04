package testutil

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/api"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/config"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

type Fixture struct {
	T           *testing.T
	Pool        *pgxpool.Pool
	Store       *store.Store
	Handler     http.Handler
	WorkspaceID uuid.UUID
	Slug        string
	User        store.User
	Token       string
}

// NewFixture gives a test a migrated database, one workspace, one signed-in
// admin, and a ready HTTP handler.
func NewFixture(t *testing.T) *Fixture {
	t.Helper()
	pool := NewPostgres(t)
	st := store.New(pool)
	ctx := t.Context()

	var wsID uuid.UUID
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Lab', 'lab', 'ENG')
		 RETURNING id`).Scan(&wsID))

	user, err := st.UpsertUserByGitHub(ctx, store.GitHubIdentity{
		ID: 1001, Login: "sabari", Name: "Sabari"})
	require.NoError(t, err)

	_, err = pool.Exec(ctx,
		`INSERT INTO membership (workspace_id, user_id, invited_login, role)
		 VALUES ($1, $2, 'sabari', 'admin')`, wsID, user.ID)
	require.NoError(t, err)

	token, err := st.CreateSession(ctx, user.ID, time.Hour)
	require.NoError(t, err)

	cfg := &config.Config{BaseURL: "http://localhost:8080",
		SessionSecret: "0123456789abcdef0123456789abcdef"}

	return &Fixture{
		T: t, Pool: pool, Store: st,
		Handler:     api.NewServer(pool, cfg).Handler(),
		WorkspaceID: wsID, Slug: "lab", User: user, Token: token,
	}
}

// Do issues an authenticated request against the fixture's handler.
func (f *Fixture) Do(method, path string, body any) *httptest.ResponseRecorder {
	f.T.Helper()
	var buf bytes.Buffer
	if body != nil {
		require.NoError(f.T, json.NewEncoder(&buf).Encode(body))
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, req)
	return rec
}

// DecodeInto unmarshals a recorder body, failing the test on bad JSON.
func (f *Fixture) DecodeInto(rec *httptest.ResponseRecorder, dst any) {
	f.T.Helper()
	require.NoError(f.T, json.Unmarshal(rec.Body.Bytes(), dst), "body: %s", rec.Body.String())
}
