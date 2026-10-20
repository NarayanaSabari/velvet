// Package typesafe is a small client for TypeSafe's System One API.
//
// Velvet uses it for one kind of judgment: which open issue a piece of
// unlinked work belongs to. The answer is only ever a suggestion that a
// person confirms, so the client returns typed probabilities and never
// decides anything on its own.
package typesafe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultBaseURL = "https://api.typesafe.ai"

	// requestTimeout bounds one call. The worker drains a shared queue, so a
	// hung connection must not stall the GitHub work queued behind it.
	requestTimeout = 20 * time.Second

	// maxResponseBytes caps what is read back. Answers are small; anything
	// larger is a misbehaving server, not a bigger answer.
	maxResponseBytes = 1 << 20
)

// ErrUnauthorized means the key is missing or rejected. Retrying cannot fix
// it, so callers complete the job instead of filling the dead letters.
var ErrUnauthorized = errors.New("typesafe: unauthorized")

// ErrRejected is a request TypeSafe will never accept as sent, such as one
// over the model's context length. Retrying the same body cannot succeed.
var ErrRejected = errors.New("typesafe: request rejected")

// Client calls POST /v1/systemone. It is safe for concurrent use.
type Client struct {
	apiKey  string
	baseURL string
	model   string
	http    *http.Client
}

// New returns a client, or nil when no key is configured. A nil client is
// the documented "suggestions off" state, so callers check for it once.
func New(apiKey, baseURL, model string) *Client {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return nil
	}
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	if model == "" {
		model = "jev-latest"
	}
	return &Client{
		apiKey:  apiKey,
		baseURL: strings.TrimSuffix(baseURL, "/"),
		model:   model,
		http:    &http.Client{Timeout: requestTimeout},
	}
}

// Choice is one System One Choice question. Criteria maps each option name to
// the description the model reads.
type Choice struct {
	Instructions string            `json:"instructions"`
	Criteria     map[string]string `json:"criteria"`
}

// ChoiceAnswer is the selected option, the probability of every option, and
// TypeSafe's confidence summary of that distribution.
type ChoiceAnswer struct {
	Choice        string             `json:"choice"`
	Confidence    float64            `json:"confidence"`
	Probabilities map[string]float64 `json:"probabilities"`
}

// Result is one answered request. Model is the versioned ID that answered,
// which is what a stored suggestion records.
type Result struct {
	Model   string
	Answers map[string]ChoiceAnswer
}

type question struct {
	Type         string            `json:"type"`
	Instructions string            `json:"instructions"`
	Criteria     map[string]string `json:"criteria"`
}

type request struct {
	Model     string              `json:"model"`
	State     any                 `json:"state"`
	Questions map[string]question `json:"questions"`
}

type response struct {
	Model   string                     `json:"model"`
	Answers map[string]json.RawMessage `json:"answers"`
}

// APIError is any other non-success response: rate limits, overload, and
// server errors. The job queue retries these with backoff, as the docs ask.
type APIError struct {
	StatusCode int
}

func (e *APIError) Error() string { return fmt.Sprintf("typesafe: status %d", e.StatusCode) }

// Choices asks every question against the same state in one request. The
// questions run in parallel on TypeSafe's side and cannot see each other.
func (c *Client) Choices(ctx context.Context, state any, questions map[string]Choice) (Result, error) {
	body := request{Model: c.model, State: state, Questions: make(map[string]question, len(questions))}
	for id, q := range questions {
		body.Questions[id] = question{Type: "choice", Instructions: q.Instructions, Criteria: q.Criteria}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return Result{}, fmt.Errorf("typesafe: encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/systemone", bytes.NewReader(payload))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		// The URL and error text never include the key, so this is safe to log.
		return Result{}, fmt.Errorf("typesafe: request failed: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		return Result{}, fmt.Errorf("typesafe: read response: %w", err)
	}

	switch {
	case res.StatusCode == http.StatusOK:
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return Result{}, ErrUnauthorized
	case res.StatusCode == http.StatusBadRequest || res.StatusCode == http.StatusRequestEntityTooLarge ||
		res.StatusCode == http.StatusUnprocessableEntity:
		// Provider bodies are not echoed: they can quote the request state.
		return Result{}, fmt.Errorf("%w (status %d)", ErrRejected, res.StatusCode)
	default:
		return Result{}, &APIError{StatusCode: res.StatusCode}
	}

	var decoded response
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return Result{}, fmt.Errorf("typesafe: decode response: %w", err)
	}
	out := Result{Model: decoded.Model, Answers: make(map[string]ChoiceAnswer, len(decoded.Answers))}
	for id := range questions {
		answerRaw, ok := decoded.Answers[id]
		if !ok {
			return Result{}, fmt.Errorf("typesafe: answer %q missing", id)
		}
		var answer ChoiceAnswer
		if err := json.Unmarshal(answerRaw, &answer); err != nil {
			return Result{}, fmt.Errorf("typesafe: decode answer %q: %w", id, err)
		}
		out.Answers[id] = answer
	}
	return out, nil
}
