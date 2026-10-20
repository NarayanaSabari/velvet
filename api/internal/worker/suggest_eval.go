package worker

import (
	"context"
	"fmt"
	"io"
	"sort"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/typesafe"
)

// EvaluateSuggestions measures Jev against links people already trust. Each
// pull request linked by its branch name is replayed as if it were unlinked,
// with the branch hidden, and Jev's answer is compared with the real issue.
// It reads only and writes nothing, so it is safe against production data.
//
// The report shows, for each probability threshold, how many suggestions
// would be shown and how many of those are right. That is the evidence for
// choosing MinSuggestionProbability.
func EvaluateSuggestions(ctx context.Context, st *store.Store, client *typesafe.Client, limit int, out io.Writer) error {
	if client == nil {
		return fmt.Errorf("TYPESAFE_API_KEY is required")
	}
	cases, err := st.SuggestionEvalCases(ctx, limit)
	if err != nil {
		return err
	}
	if len(cases) == 0 {
		fmt.Fprintln(out, "No pull requests linked by branch name to replay.")
		return nil
	}

	type result struct {
		p       float64
		correct bool
		none    bool
	}
	var results []result
	inPool := 0
	for _, c := range cases {
		candidates, err := st.SuggestionCandidates(ctx, c.Subject.WorkspaceID, c.Subject.ProjectID, c.Subject.AuthorID)
		if err != nil {
			return err
		}
		found := false
		for _, cand := range candidates {
			found = found || cand.Key == c.IssueKey
		}
		if !found {
			// The real issue is closed or outranked, so no answer could be right.
			continue
		}
		inPool++
		answer, err := client.Choices(ctx, suggestionState(c.Subject, candidates), map[string]typesafe.Choice{
			"issue": suggestionQuestion(c.Subject, candidates),
		})
		if err != nil {
			return err
		}
		a := answer.Answers["issue"]
		results = append(results, result{
			p:       a.Probabilities[a.Choice],
			correct: a.Choice == c.IssueKey,
			none:    a.Choice == noMatchOption,
		})
	}

	fmt.Fprintf(out, "Replayed %d of %d branch-linked pull requests (the rest had a closed or outranked issue).\n\n", inPool, len(cases))
	fmt.Fprintln(out, "threshold  shown  correct  precision  coverage")
	thresholds := []float64{0.4, 0.5, 0.6, 0.7, 0.8, 0.9}
	sort.Float64s(thresholds)
	for _, t := range thresholds {
		shown, correct := 0, 0
		for _, r := range results {
			if r.none || r.p < t {
				continue
			}
			shown++
			if r.correct {
				correct++
			}
		}
		precision := 0.0
		if shown > 0 {
			precision = float64(correct) / float64(shown)
		}
		coverage := 0.0
		if len(results) > 0 {
			coverage = float64(correct) / float64(len(results))
		}
		marker := ""
		if t == MinSuggestionProbability {
			marker = "  <- current"
		}
		fmt.Fprintf(out, "%9.2f  %5d  %7d  %9.0f%%  %7.0f%%%s\n", t, shown, correct, precision*100, coverage*100, marker)
	}
	return nil
}
