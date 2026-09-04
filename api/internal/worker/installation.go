package worker

import (
	"context"
	"encoding/json"
	"fmt"
)

type installationEvent struct {
	Action       string `json:"action"`
	Installation struct {
		ID      int64 `json:"id"`
		Account struct {
			Login string `json:"login"`
		} `json:"account"`
	} `json:"installation"`
}

// handleInstallation keeps the installation record current, including
// suspension. A suspended installation still has repositories linked, so the
// history stays readable even while the App cannot call GitHub.
func (w *Worker) handleInstallation(ctx context.Context, payload []byte) error {
	var ev installationEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		return fmt.Errorf("decode installation event: %w", err)
	}
	if ev.Installation.ID == 0 {
		return nil
	}
	suspended := ev.Action == "suspend"
	return w.store.UpsertInstallation(ctx, ev.Installation.ID,
		ev.Installation.Account.Login, suspended)
}
