// Package client is the CLI's HTTP client for one Velvet server.
package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

// Client talks to one server, optionally with a key.
type Client struct {
	Base  string
	Token string
	HTTP  *http.Client
	// UserAgent identifies the CLI build in server logs.
	UserAgent string
}

// New returns a client for base, the server URL without /api/v1.
func New(base, token, version string) *Client {
	return &Client{
		Base:      base,
		Token:     token,
		HTTP:      &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }},
		UserAgent: "velvet-cli/" + version,
	}
}

// Error is a non-2xx answer from the server.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("Velvet returned HTTP %d", e.Status)
}

// StatusOf reports an Error's HTTP status, or 0.
func StatusOf(err error) int {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	return 0
}

func (c *Client) url(path string, query url.Values) string {
	u := c.Base + "/api/v1" + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

// Do sends a JSON request and decodes a JSON answer into out, when non-nil.
func (c *Client) Do(method, path string, query url.Values, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.url(path, query), reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.send(req, out)
}

// Text sends a GET and returns the raw body, for Markdown endpoints.
func (c *Client) Text(path string, query url.Values) (string, error) {
	req, err := http.NewRequest(http.MethodGet, c.url(path, query), nil)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := c.send(req, &buf); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// Upload posts one file as multipart field "file" with a caption.
func (c *Client) Upload(path, file, caption string, out any) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	if err := form.WriteField("caption", caption); err != nil {
		return err
	}
	part, err := form.CreateFormFile("file", filepath.Base(file))
	if err != nil {
		return err
	}
	if _, err := io.Copy(part, io.LimitReader(f, 10<<20+1)); err != nil {
		return err
	}
	if err := form.Close(); err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.url(path, nil), &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	return c.send(req, out)
}

func (c *Client) send(req *http.Request, out any) error {
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach %s: %w", c.Base, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || resp.StatusCode == http.StatusAccepted {
		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &envelope)
		return &Error{Status: resp.StatusCode, Code: envelope.Error.Code, Message: envelope.Error.Message}
	}
	switch dst := out.(type) {
	case nil:
		return nil
	case *bytes.Buffer:
		_, err := dst.Write(raw)
		return err
	default:
		if len(raw) == 0 {
			return nil
		}
		return json.Unmarshal(raw, out)
	}
}
