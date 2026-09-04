package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
)

// Broker fans activity out to connected browsers. It is intentionally
// in-process: a dropped event costs a client one refresh, never data, so a
// durable bus would be complexity without a matching risk.
type Broker struct {
	mu   sync.RWMutex
	subs map[uuid.UUID]map[chan store.Activity]struct{}
}

func NewBroker() *Broker {
	return &Broker{subs: make(map[uuid.UUID]map[chan store.Activity]struct{})}
}

func (b *Broker) Subscribe(workspaceID uuid.UUID) (<-chan store.Activity, func()) {
	ch := make(chan store.Activity, 16)
	b.mu.Lock()
	if b.subs[workspaceID] == nil {
		b.subs[workspaceID] = make(map[chan store.Activity]struct{})
	}
	b.subs[workspaceID][ch] = struct{}{}
	b.mu.Unlock()

	var once sync.Once
	return ch, func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subs[workspaceID], ch)
			if len(b.subs[workspaceID]) == 0 {
				delete(b.subs, workspaceID)
			}
			b.mu.Unlock()
			close(ch)
		})
	}
}

// Publish never blocks: a subscriber too slow to keep up drops the event
// rather than stalling the request that produced it.
func (b *Broker) Publish(workspaceID uuid.UUID, a store.Activity) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs[workspaceID] {
		select {
		case ch <- a:
		default:
		}
	}
}

// publishRecent republishes the activity rows written above a known id, so a
// handler only has to remember the id it saw before the mutation.
func (s *Server) publishRecent(ctx context.Context, workspaceID uuid.UUID, sinceID int64) {
	rows, _, err := s.store.ListActivity(ctx, workspaceID, store.ActivityFilter{Limit: 10})
	if err != nil {
		return
	}
	for i := len(rows) - 1; i >= 0; i-- {
		if rows[i].ID > sinceID {
			s.broker.Publish(workspaceID, rows[i])
		}
	}
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		WriteError(w, http.StatusInternalServerError, "internal", "streaming unsupported")
		return
	}
	ws, _ := CurrentWorkspace(r.Context())

	// Subscribing before the first flush closes the window in which a mutation
	// could land after the client believes it is connected but before it is.
	events, unsubscribe := s.broker.Subscribe(ws.WorkspaceID)
	defer unsubscribe()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case ev := <-events:
			payload, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: activity\ndata: %s\n\n", payload)
			flusher.Flush()
		}
	}
}
