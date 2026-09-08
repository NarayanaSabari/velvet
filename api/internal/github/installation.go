package github

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

var ErrInstallationRepositories = errors.New("could not list installation repositories")

// ListInstallationRepositories rejects incomplete lists, redirect responses,
// and pagination outside the configured REST origin and exact endpoint.
// Provider bodies and temporary credentials never escape this boundary.
func (c *Client) ListInstallationRepositories(ctx context.Context, id int64) ([]Repository, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	token, err := c.InstallationToken(ctx, id)
	if err != nil {
		return nil, ErrInstallationRepositories
	}
	endpoint := "/installation/repositories"
	next := c.baseURL + endpoint + "?per_page=100"
	visited := map[string]bool{}
	seen := map[int64]bool{}
	out := []Repository{}
	total := -1
	for pages := 0; next != ""; pages++ {
		if pages >= 100 || visited[next] {
			return nil, ErrInstallationRepositories
		}
		visited[next] = true
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, next, nil)
		if err != nil {
			return nil, ErrInstallationRepositories
		}
		req.Header.Set("Authorization", "Bearer "+token)
		setCommonHeaders(req)
		resp, err := c.http.Do(req)
		if err != nil {
			return nil, ErrInstallationRepositories
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024+1))
		resp.Body.Close()
		if readErr != nil || len(body) > 2*1024*1024 || resp.StatusCode != 200 {
			return nil, ErrInstallationRepositories
		}
		var page struct {
			Total        *int          `json:"total_count"`
			Repositories *[]Repository `json:"repositories"`
		}
		if json.Unmarshal(body, &page) != nil || page.Total == nil || *page.Total < 0 || page.Repositories == nil {
			return nil, ErrInstallationRepositories
		}
		if total != -1 && total != *page.Total {
			return nil, ErrInstallationRepositories
		}
		total = *page.Total
		for _, repo := range *page.Repositories {
			if repo.ID <= 0 || repo.Owner == "" || repo.Name == "" || seen[repo.ID] {
				return nil, ErrInstallationRepositories
			}
			seen[repo.ID] = true
			out = append(out, repo)
		}
		next, err = trustedNextPage(c.baseURL, resp.Header.Values("Link"), endpoint)
		if err != nil || len(out) > total {
			return nil, ErrInstallationRepositories
		}
	}
	if len(out) != total {
		return nil, ErrInstallationRepositories
	}
	return out, nil
}
