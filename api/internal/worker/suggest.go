package worker

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/typesafe"
	"github.com/google/uuid"
)

const (
	// suggestInterval is how often the worker looks for unlinked work. The
	// pass is a cheap query when nothing is stale.
	suggestInterval = 10 * time.Second
	// suggestBatch bounds the work asked about per kind in one pass, so a
	// large backfill shares the worker with GitHub jobs.
	suggestBatch = 10
	// suggestBackoff is how long the pass pauses after TypeSafe refuses the
	// key or is unavailable.
	suggestBackoff = 5 * time.Minute

	// MinSuggestionProbability is the least probability Jev must give one
	// issue before it is shown. A wrong suggestion costs a person a click to
	// dismiss; a confident one saves them a lookup.
	MinSuggestionProbability = 0.6

	noMatchOption = "none_of_these"
)

// WithSuggester turns on Jev suggestions. A nil client leaves them off, which
// is the state of every deployment without a TypeSafe key.
func (w *Worker) WithSuggester(c *typesafe.Client) *Worker {
	w.suggester = c
	return w
}

// SuggestOnce asks about one batch of stale work and reports how many items
// it answered. Tests call it directly; Run calls it on a timer.
func (w *Worker) SuggestOnce(ctx context.Context) (int, error) {
	if w.suggester == nil {
		return 0, nil
	}
	subjects, err := w.store.StaleSuggestionSubjects(ctx, suggestBatch)
	if err != nil {
		return 0, err
	}
	done := 0
	for _, sub := range subjects {
		if err := w.suggest(ctx, sub); err != nil {
			return done, err
		}
		done++
	}
	return done, nil
}

func (w *Worker) suggest(ctx context.Context, sub store.SuggestionSubject) error {
	candidates, err := w.store.SuggestionCandidates(ctx, sub.WorkspaceID, sub.ProjectID, sub.AuthorID)
	if err != nil {
		return err
	}
	save := store.SaveSuggestionInput{
		Kind: sub.Kind, SubjectID: sub.SubjectID, WorkspaceID: sub.WorkspaceID, Fingerprint: sub.Fingerprint,
	}
	// With no open issue there is nothing to choose from. Record that, so the
	// same work is asked about again only once an issue exists.
	if len(candidates) == 0 {
		return w.store.SaveSuggestion(ctx, save)
	}

	result, err := w.suggester.Choices(ctx, suggestionState(sub, candidates), map[string]typesafe.Choice{
		"issue": suggestionQuestion(sub, candidates),
	})
	if errors.Is(err, typesafe.ErrRejected) {
		// The same request can never succeed, so record "no match" rather
		// than asking again on every pass.
		slog.Warn("jev suggestion rejected", "kind", sub.Kind, "id", sub.SubjectID)
		return w.store.SaveSuggestion(ctx, save)
	}
	if err != nil {
		return err
	}

	save.Model = result.Model
	if issueID, p, ok := pickSuggestion(result.Answers["issue"], candidates); ok {
		save.IssueID, save.Probability = &issueID, &p
	}
	return w.store.SaveSuggestion(ctx, save)
}

// pickSuggestion applies the policy: one named issue, above the threshold.
// "None of these" and a spread-out answer both mean no suggestion.
func pickSuggestion(answer typesafe.ChoiceAnswer, candidates []store.SuggestionCandidate) (uuid.UUID, float64, bool) {
	if answer.Choice == "" || answer.Choice == noMatchOption {
		return uuid.Nil, 0, false
	}
	p := answer.Probabilities[answer.Choice]
	if p < MinSuggestionProbability {
		return uuid.Nil, 0, false
	}
	for _, c := range candidates {
		if c.Key == answer.Choice {
			return c.ID, p, true
		}
	}
	return uuid.Nil, 0, false
}

func suggestionState(sub store.SuggestionSubject, candidates []store.SuggestionCandidate) map[string]any {
	return map[string]any{
		"work":        sub.Work,
		"open_issues": candidates,
	}
}

func suggestionQuestion(sub store.SuggestionSubject, candidates []store.SuggestionCandidate) typesafe.Choice {
	what := "pull request"
	if sub.Kind == store.SuggestionNote {
		what = "work log note"
	}
	criteria := make(map[string]string, len(candidates)+1)
	for _, c := range candidates {
		criteria[c.Key] = c.Key + ": " + c.Title
	}
	criteria[noMatchOption] = "None of the open issues is the work this " + what + " describes. " +
		"Choose this when the work only relates loosely to an issue, touches the same area for a different purpose, or matches nothing."
	return typesafe.Choice{
		Instructions: "`work` is a " + what + " that is not yet filed under an issue. `open_issues` lists the " +
			"organisation's open issues. Which issue is this work actually done for, meaning the work makes progress " +
			"on that issue's stated goal? Judge by what the work changes or reports, using its title, body, branch, " +
			"commit messages, and project, not by shared words alone.",
		Criteria: criteria,
	}
}

// runSuggestions is the pass Run schedules. Failures pause it rather than
// stopping the worker: GitHub sync must keep working without TypeSafe.
func (w *Worker) runSuggestions(ctx context.Context) {
	if w.suggester == nil || time.Now().Before(w.suggestPausedUntil) {
		return
	}
	if _, err := w.SuggestOnce(ctx); err != nil {
		if ctx.Err() != nil {
			return
		}
		w.suggestPausedUntil = time.Now().Add(suggestBackoff)
		if errors.Is(err, typesafe.ErrUnauthorized) {
			slog.Error("jev suggestions paused: TypeSafe rejected the API key")
			return
		}
		slog.Error("jev suggestions paused", "err", err)
	}
}
