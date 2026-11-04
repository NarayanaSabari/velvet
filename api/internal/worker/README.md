# worker

## Overview
Background loop that drains the `job` queue, reconciles GitHub state, cleans up auth rows and asks Jev for link suggestions.

## Interface
- `type Worker`, `func New(st *store.Store, gh *github.Client) *Worker`
- `func (w *Worker) WithSuggester(c *typesafe.Client) *Worker`
- `func (w *Worker) Run(ctx context.Context) error`
- `func (w *Worker) ProcessOnce(ctx context.Context) (bool, error)`
- `func (w *Worker) Reconcile(ctx context.Context) error`
- `func (w *Worker) SuggestOnce(ctx context.Context) (int, error)`
- [EvaluateSuggestions](suggest_eval.go): `func EvaluateSuggestions(ctx context.Context, st *store.Store, client *typesafe.Client, limit int, out io.Writer) error`
- `const MinSuggestionProbability = 0.6`
- Job kinds: `sync_installation_repos`, `sync_installation_state`, `process_delivery`. Delivery events: `pull_request`, `pull_request_review`, `push`, `installation`, `installation_repositories`.

## Invariants
- `Run` reconciles once at start, then on `reconcileInterval`.
- [Suggestions](suggest.go) run every 10 seconds, at most 10 subjects per kind. Only an error returned by `SuggestOnce` triggers five-minute backoff. `ErrRejected` is saved as a no-match result, not returned for backoff.
- A nil suggester disables suggestions. A nil GitHub client makes [Reconcile](reconcile.go) return without work, but current [installation-sync jobs](installation.go) record failure and retry. A [review](review.go) missing its mirrored PR also fails without GitHub. Nil GitHub is not a blanket successful no-op.
- Failed jobs go to `FailJob`. Finished jobs go to `CompleteJob`. Processed deliveries are marked through `MarkDeliveryProcessed`.
- [Reconciliation](reconcile.go) initially fetches 90 days of PR history; later runs overlap `synced_at` by one second. Only a successful run advances `synced_at`, to the fetch start time, under the active-repository guard.
- [Push attribution](push.go) searches only the branch, never commit messages, and selects the first matched issue key. If that key does not resolve, commits remain unattributed rather than trying later matches.
- [PR synchronization](pull_request.go) links every resolvable issue reference and records evidence/activity, never changing issue status, including when the PR merges.

## Side Effects
- Reads and writes Postgres through `store`.
- Calls the GitHub REST API and the TypeSafe API.
- `EvaluateSuggestions` writes to `out`.

## Verification
- Run: `cd api && go test ./internal/worker/...`
