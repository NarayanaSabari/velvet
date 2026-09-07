package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const resendBaseURL = "https://api.resend.com"

type Resend struct {
	apiKey  string
	from    string
	http    *http.Client
	baseURL string
}

// NewResend sends through Resend's REST API. baseURL is overridable for tests.
func NewResend(apiKey, from string, httpClient *http.Client, baseURL string) *Resend {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if baseURL == "" {
		baseURL = resendBaseURL
	}
	return &Resend{apiKey: apiKey, from: from, http: httpClient, baseURL: strings.TrimRight(baseURL, "/")}
}

func (r *Resend) Send(ctx context.Context, m Message) error {
	body, err := json.Marshal(map[string]any{
		"from":    r.from,
		"to":      []string{m.To},
		"subject": m.Subject,
		"text":    m.Text,
		"html":    m.HTML,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/emails", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.apiKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := r.http.Do(req)
	if err != nil {
		return fmt.Errorf("resend: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("resend: status %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}
