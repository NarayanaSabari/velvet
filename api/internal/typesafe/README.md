# typesafe

## Overview
HTTP client for the TypeSafe (Jev) multiple-choice API used for link suggestions.

## Interface
- `type Client`, `func New(apiKey, baseURL, model string) *Client`
- `func (c *Client) Choices(ctx, state any, questions map[string]Choice) (Result, error)`
- `type Choice`, `type ChoiceAnswer`, `type Result`, `type APIError`
- `var ErrUnauthorized`, `var ErrRejected`

## Invariants
- `New` returns nil without an API key. Callers treat a nil client as suggestions off.
- [Choices](client.go) posts bearer-authenticated JSON (`model`, `state`, `questions`, each question with `type="choice"`, `instructions`, `criteria`) to `/v1/systemone`. The HTTP timeout is 20 seconds; response reading is limited to 1 MiB.
- A successful response must contain every requested answer key. Each answer decodes into `choice`, `confidence`, and `probabilities`; the result also carries the model ID. Missing answer keys or answer decoding failures return an error. Decoding does not validate required answer fields, choice membership, probability ranges or totals, confidence, or model ID; `null` and `{}` can decode into zero-valued answers.
- HTTP `401/403` returns `ErrUnauthorized`; `400/413/422` wraps `ErrRejected`; all other non-200 statuses return `*APIError` with `StatusCode`. Provider error bodies are not echoed.

## Side Effects
- Network calls to the TypeSafe API.

## Verification
- Run: `cd api && go test ./internal/typesafe/...`
