package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

// newcomer signs in a person who belongs to no organisation yet.
func newcomer(t *testing.T, f *testutil.Fixture, email, name string) string {
	t.Helper()
	user, err := f.Store.UpsertUserByEmail(t.Context(), email)
	require.NoError(t, err)
	if name != "" {
		_, err = f.Pool.Exec(t.Context(), `UPDATE app_user SET name=$1 WHERE id=$2`, name, user.ID)
		require.NoError(t, err)
	}
	session, err := f.Store.CreateSession(t.Context(), user.ID, time.Hour)
	require.NoError(t, err)
	return session
}

func doAs(f *testutil.Fixture, session, method, path string, body any) *httptest.ResponseRecorder {
	f.T.Helper()
	g := *f
	g.Token = session
	return g.Do(method, path, body)
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), dst), rec.Body.String())
}

type onboardingResponse struct {
	State      store.OnboardingState      `json:"state"`
	Suggestion store.OrganisationDefaults `json:"suggestion"`
	BaseURL    string                     `json:"base_url"`
}

func TestOnboardingSuggestsAnOrganisationNamedAfterThePerson(t *testing.T) {
	f := testutil.NewFixture(t)
	session := newcomer(t, f, "priya.raman@example.com", "Priya Raman")

	res := doAs(f, session, http.MethodGet, "/api/v1/me/onboarding", nil)
	require.Equal(t, http.StatusOK, res.Code, res.Body.String())
	var body onboardingResponse
	decode(t, res, &body)
	require.Equal(t, store.OnboardingState{}, body.State)
	require.Equal(t, store.OrganisationDefaults{Name: "Priya Raman", Slug: "priya-raman", IssuePrefix: "PR"}, body.Suggestion)
	require.Equal(t, "http://localhost:8080", body.BaseURL)
}

// Email sign-up often has no name, so the suggestion falls back to the email.
func TestOnboardingFallsBackToTheEmailWhenThereIsNoName(t *testing.T) {
	f := testutil.NewFixture(t)
	session := newcomer(t, f, "kumar_dev@example.com", "")

	res := doAs(f, session, http.MethodGet, "/api/v1/me/onboarding", nil)
	var body onboardingResponse
	decode(t, res, &body)
	require.Equal(t, store.OrganisationDefaults{Name: "Kumar Dev", Slug: "kumar-dev", IssuePrefix: "KD"}, body.Suggestion)
}

// One click creates the organisation from the defaults, and the person is its admin.
func TestOnboardingCreatesTheOrganisationFromDefaults(t *testing.T) {
	f := testutil.NewFixture(t)
	session := newcomer(t, f, "priya@example.com", "Priya Raman")

	res := doAs(f, session, http.MethodPost, "/api/v1/me/onboarding/organisation", map[string]any{})
	require.Equal(t, http.StatusCreated, res.Code, res.Body.String())
	var m store.Membership
	decode(t, res, &m)
	require.Equal(t, "priya-raman", m.Slug)
	require.Equal(t, "Priya Raman", m.Name)
	require.Equal(t, "PR", m.IssuePrefix)
	require.Equal(t, "admin", m.Role)

	res = doAs(f, session, http.MethodGet, "/api/v1/me/onboarding", nil)
	var body onboardingResponse
	decode(t, res, &body)
	require.True(t, body.State.HasOrganisation)
}

// Two people with the same name both get through, the second with a number.
func TestOnboardingMovesToAFreeSlugWhenTheNameIsTaken(t *testing.T) {
	f := testutil.NewFixture(t)
	first := newcomer(t, f, "sam1@example.com", "Sam Lee")
	second := newcomer(t, f, "sam2@example.com", "Sam Lee")

	res := doAs(f, first, http.MethodPost, "/api/v1/me/onboarding/organisation", map[string]any{})
	require.Equal(t, http.StatusCreated, res.Code, res.Body.String())

	// The second person's form may still hold the slug the first one just took.
	res = doAs(f, second, http.MethodPost, "/api/v1/me/onboarding/organisation", map[string]any{"slug": "sam-lee"})
	require.Equal(t, http.StatusCreated, res.Code, res.Body.String())
	var m store.Membership
	decode(t, res, &m)
	require.Equal(t, "sam-lee-2", m.Slug)
}

func TestOnboardingAcceptsEditedValuesAndRejectsInvalidOnes(t *testing.T) {
	f := testutil.NewFixture(t)
	session := newcomer(t, f, "ops@example.com", "Ops Team")

	for _, bad := range []map[string]any{
		{"slug": "admin"},
		{"slug": "x"},
		{"issue_prefix": "TOOLONGX"},
		{"issue_prefix": "1A"},
	} {
		res := doAs(f, session, http.MethodPost, "/api/v1/me/onboarding/organisation", bad)
		require.Equal(t, http.StatusBadRequest, res.Code, bad)
	}

	res := doAs(f, session, http.MethodPost, "/api/v1/me/onboarding/organisation",
		map[string]any{"name": "Acme Platform", "slug": "acme-platform", "issue_prefix": "acm"})
	require.Equal(t, http.StatusCreated, res.Code, res.Body.String())
	var m store.Membership
	decode(t, res, &m)
	require.Equal(t, "Acme Platform", m.Name)
	require.Equal(t, "acme-platform", m.Slug)
	require.Equal(t, "ACM", m.IssuePrefix)
}

// Onboarding manages identity, so an agent token cannot drive it.
func TestOnboardingRequiresABrowserSession(t *testing.T) {
	f := testutil.NewFixture(t)
	token := f.AgentToken("agent")
	rec := f.DoAsAgent(http.MethodPost, "/api/v1/me/onboarding/organisation", token, map[string]any{})
	require.Equal(t, http.StatusForbidden, rec.Code)
	rec = f.DoAsAgent(http.MethodGet, "/api/v1/me/onboarding", token, nil)
	require.Equal(t, http.StatusForbidden, rec.Code)

	req := f.Do(http.MethodGet, "/api/v1/me/onboarding", nil)
	require.Equal(t, http.StatusOK, req.Code)
}

func TestDefaultNamingHandlesAwkwardNames(t *testing.T) {
	cases := []struct {
		user   store.User
		name   string
		slug   string
		prefix string
	}{
		{store.User{Name: "Sabari Narayana"}, "Sabari Narayana", "sabari-narayana", "SN"},
		{store.User{Name: "  Sébastien   Côté "}, "Sébastien Côté", "sebastien-cote", "SC"},
		{store.User{Name: "Ada"}, "Ada", "ada", "ADA"},
		{store.User{Name: "Jo"}, "Jo", "jo-work", "JO"},
		{store.User{Name: "Anna Maria Bella Luna"}, "Anna Maria Bella Luna", "anna-maria-bella-luna", "AMB"},
		{store.User{Name: "அருண்"}, "அருண்", "my-work", "WRK"},
		{store.User{Email: "admin@example.com"}, "Admin", "admin-work", "ADM"},
		{store.User{Email: "x@example.com"}, "X", "x-work", "WRK"},
	}
	for _, c := range cases {
		name := store.DefaultOrganisationName(c.user)
		require.Equal(t, c.name, name)
		require.Equal(t, c.slug, store.SlugFrom(name), name)
		require.Equal(t, c.prefix, store.PrefixFrom(name), name)
	}
}
