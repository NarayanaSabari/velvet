package github

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultBaseURL = "https://api.github.com"

	// apiVersion pins the REST schema. Without it GitHub is free to move the
	// default version under a long-running deployment.
	apiVersion = "2022-11-28"

	// requestTimeout bounds a single call. The worker drains a queue, so a
	// hung connection must not stall every later job behind it.
	requestTimeout = 30 * time.Second

	// perPage is GitHub's maximum, which minimises requests against the
	// 5,000/hour installation budget.
	perPage = 100
)

// ErrRateLimited is the sentinel every caller matches with errors.Is. The
// reconciler uses it to stop early and leave synced_at untouched, so the next
// run resumes the gap rather than skipping it.
var ErrRateLimited = errors.New("github: rate limited")

// RateLimitError carries the reset time so a caller can wait exactly as long
// as GitHub asks, instead of guessing a backoff.
type RateLimitError struct {
	ResetAt time.Time
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("github: rate limited until %s", e.ResetAt.Format(time.RFC3339))
}

func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimited }

// APIError is any other non-success response. The body is included because
// GitHub's message field is usually the whole diagnosis; the request's
// Authorization header never is.
type APIError struct {
	StatusCode int
	Method     string
	Path       string
	Message    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("github: %s %s: %d %s", e.Method, e.Path, e.StatusCode, e.Message)
}

// Client is a GitHub App API client. It is safe for concurrent use.
type Client struct {
	appID      string
	privateKey *rsa.PrivateKey
	baseURL    string
	http       *http.Client

	mu     sync.Mutex
	tokens map[int64]cachedToken
}

// NewClient builds a client for one GitHub App. baseURL may be empty, in
// which case the public API is used; tests point it at a stub server.
func NewClient(appID string, privateKeyPEM []byte, baseURL string) (*Client, error) {
	if appID == "" {
		return nil, errors.New("github: app id is required")
	}
	key, err := parsePrivateKey(privateKeyPEM)
	if err != nil {
		return nil, err
	}
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	return &Client{
		appID:      appID,
		privateKey: key,
		baseURL:    strings.TrimSuffix(baseURL, "/"),
		http:       &http.Client{Timeout: requestTimeout},
		tokens:     make(map[int64]cachedToken),
	}, nil
}

// Repository mirrors the repository fields the schema stores.
type Repository struct {
	ID            int64  `json:"id"`
	Owner         string `json:"-"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	DefaultBranch string `json:"default_branch"`
}

// UnmarshalJSON lifts the nested owner login into a flat field, which is how
// every caller and the repo table use it.
func (r *Repository) UnmarshalJSON(b []byte) error {
	var raw struct {
		ID            int64  `json:"id"`
		Name          string `json:"name"`
		FullName      string `json:"full_name"`
		DefaultBranch string `json:"default_branch"`
		Owner         struct {
			Login string `json:"login"`
		} `json:"owner"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	r.ID, r.Name, r.FullName, r.DefaultBranch = raw.ID, raw.Name, raw.FullName, raw.DefaultBranch
	r.Owner = raw.Owner.Login
	return nil
}

// PullRequest mirrors the pull_request table. State is normalised: a closed
// PR that was merged reports "merged", because "closed" would misreport
// abandoned work and delivered work as the same thing.
type PullRequest struct {
	Number      int
	Title       string
	State       string
	Draft       bool
	AuthorLogin string
	HeadRef     string
	BaseRef     string
	Body        string
	Additions   int
	Deletions   int
	HTMLURL     string
	MergedAt    *time.Time
	ClosedAt    *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

func (p *PullRequest) UnmarshalJSON(b []byte) error {
	var raw struct {
		Number    int        `json:"number"`
		Title     string     `json:"title"`
		State     string     `json:"state"`
		Draft     bool       `json:"draft"`
		Body      string     `json:"body"`
		Additions int        `json:"additions"`
		Deletions int        `json:"deletions"`
		HTMLURL   string     `json:"html_url"`
		MergedAt  *time.Time `json:"merged_at"`
		ClosedAt  *time.Time `json:"closed_at"`
		CreatedAt time.Time  `json:"created_at"`
		UpdatedAt time.Time  `json:"updated_at"`
		User      struct {
			Login string `json:"login"`
		} `json:"user"`
		Head struct {
			Ref string `json:"ref"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
		} `json:"base"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	p.Number, p.Title, p.Draft = raw.Number, raw.Title, raw.Draft
	p.Body, p.Additions, p.Deletions = raw.Body, raw.Additions, raw.Deletions
	p.HTMLURL, p.MergedAt, p.ClosedAt = raw.HTMLURL, raw.MergedAt, raw.ClosedAt
	p.CreatedAt, p.UpdatedAt = raw.CreatedAt, raw.UpdatedAt
	p.AuthorLogin = raw.User.Login
	p.HeadRef, p.BaseRef = raw.Head.Ref, raw.Base.Ref
	p.State = NormalizeState(raw.State, raw.MergedAt)
	return nil
}

// NormalizeState maps the API's open/closed plus merged_at onto the three
// states the schema stores. Exported because webhook payloads carry the same
// shape and must normalise identically.
func NormalizeState(apiState string, mergedAt *time.Time) string {
	if mergedAt != nil && !mergedAt.IsZero() {
		return "merged"
	}
	switch apiState {
	case "open", "closed":
		return apiState
	default:
		return "closed"
	}
}

// Review mirrors the pr_review table.
type Review struct {
	ID            int64  `json:"id"`
	ReviewerLogin string `json:"-"`
	State         string `json:"state"`
	Body          string `json:"body"`
	HTMLURL       string `json:"html_url"`
	SubmittedAt   time.Time
}

func (rv *Review) UnmarshalJSON(b []byte) error {
	var raw struct {
		ID   int64 `json:"id"`
		User struct {
			Login string `json:"login"`
		} `json:"user"`
		State       string    `json:"state"`
		Body        string    `json:"body"`
		HTMLURL     string    `json:"html_url"`
		SubmittedAt time.Time `json:"submitted_at"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	rv.ID, rv.State, rv.Body = raw.ID, raw.State, raw.Body
	rv.HTMLURL, rv.SubmittedAt = raw.HTMLURL, raw.SubmittedAt
	rv.ReviewerLogin = raw.User.Login
	return nil
}

// ListPullRequests returns every pull request updated at or after since,
// newest first. Passing the zero time returns all of them.
//
// The pulls endpoint has no `since` parameter, so the cutoff is applied
// client-side against a descending sort: once a page runs older than since,
// every later page is older too and fetching continues no further.
func (c *Client) ListPullRequests(ctx context.Context, installationID int64, owner, repo string, since time.Time) ([]PullRequest, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/pulls?state=all&sort=updated&direction=desc&per_page=%d",
		c.baseURL, owner, repo, perPage)

	var out []PullRequest
	for url != "" {
		var page []PullRequest
		resp, err := c.getJSON(ctx, installationID, url, "", &page)
		if err != nil {
			return nil, err
		}
		for _, pr := range page {
			if !since.IsZero() && pr.UpdatedAt.Before(since) {
				return out, nil
			}
			out = append(out, pr)
		}
		url = nextPageURL(resp.Header.Get("Link"))
	}
	return out, nil
}

// GetPullRequest fetches one pull request unconditionally.
func (c *Client) GetPullRequest(ctx context.Context, installationID int64, owner, repo string, number int) (PullRequest, error) {
	pr, _, _, err := c.GetPullRequestConditional(ctx, installationID, owner, repo, number, "")
	return pr, err
}

// GetPullRequestConditional sends If-None-Match when etag is non-empty and
// reports changed=false on a 304. An unchanged PR then costs nothing against
// the hourly budget, which is what makes frequent reconciliation affordable.
// The returned etag is the one to store for the next call.
func (c *Client) GetPullRequestConditional(ctx context.Context, installationID int64, owner, repo string, number int, etag string) (pr PullRequest, newETag string, changed bool, err error) {
	url := fmt.Sprintf("%s/repos/%s/%s/pulls/%d", c.baseURL, owner, repo, number)

	resp, err := c.getJSON(ctx, installationID, url, etag, &pr)
	if err != nil {
		return PullRequest{}, etag, false, err
	}
	if resp.StatusCode == http.StatusNotModified {
		return PullRequest{}, etag, false, nil
	}
	return pr, resp.Header.Get("ETag"), true, nil
}

// ListReviews returns every review on a pull request, oldest first as GitHub
// returns them.
func (c *Client) ListReviews(ctx context.Context, installationID int64, owner, repo string, number int) ([]Review, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/pulls/%d/reviews?per_page=%d", c.baseURL, owner, repo, number, perPage)

	var out []Review
	for url != "" {
		var page []Review
		resp, err := c.getJSON(ctx, installationID, url, "", &page)
		if err != nil {
			return nil, err
		}
		out = append(out, page...)
		url = nextPageURL(resp.Header.Get("Link"))
	}
	return out, nil
}

// getJSON performs one authenticated GET and decodes the body into out. On a
// 304 the body is drained and out is left untouched, so the caller keeps
// whatever it already had.
func (c *Client) getJSON(ctx context.Context, installationID int64, url, etag string, out any) (*http.Response, error) {
	token, err := c.InstallationToken(ctx, installationID)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("github: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	setCommonHeaders(req)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		// The URL is safe to report; the token lives only in a header.
		return nil, fmt.Errorf("github: GET %s: %w", req.URL.Path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp, nil
	}
	if err := checkResponse(resp); err != nil {
		return nil, err
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return nil, fmt.Errorf("github: decode %s: %w", resp.Request.URL.Path, err)
	}
	return resp, nil
}

func setCommonHeaders(req *http.Request) {
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", apiVersion)
}

// checkResponse converts a non-success status into an error, distinguishing
// exhaustion of the rate limit from an ordinary 403 so a caller can back off
// rather than treat a temporary limit as a permission problem.
func checkResponse(resp *http.Response) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		if resp.Header.Get("X-RateLimit-Remaining") == "0" {
			return &RateLimitError{ResetAt: parseResetHeader(resp.Header.Get("X-RateLimit-Reset"))}
		}
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	return &APIError{
		StatusCode: resp.StatusCode,
		Method:     resp.Request.Method,
		Path:       resp.Request.URL.Path,
		Message:    strings.TrimSpace(string(body)),
	}
}

// parseResetHeader reads the Unix-seconds reset stamp, falling back to a
// minute out when the header is missing or unparseable, so a caller always
// has a usable time to wait until.
func parseResetHeader(v string) time.Time {
	if secs, err := strconv.ParseInt(v, 10, 64); err == nil && secs > 0 {
		return time.Unix(secs, 0)
	}
	return time.Now().Add(time.Minute)
}

// linkNextRe matches the rel="next" entry of an RFC 5988 Link header.
var linkNextRe = regexp.MustCompile(`<([^>]+)>\s*;\s*rel="next"`)

// nextPageURL returns the next page URL, or "" at the end of the results.
// Following the header rather than incrementing a page counter is what keeps
// a second page from being silently dropped.
func nextPageURL(link string) string {
	if link == "" {
		return ""
	}
	if m := linkNextRe.FindStringSubmatch(link); m != nil {
		return m[1]
	}
	return ""
}
