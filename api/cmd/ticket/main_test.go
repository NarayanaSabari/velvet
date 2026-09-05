package main

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestServeStopsCleanlyWhenCancelled(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}),
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, srv, listener) }()

	require.Eventually(t, func() bool {
		client := &http.Client{Timeout: 100 * time.Millisecond}
		res, err := client.Get("http://" + listener.Addr().String())
		if err != nil {
			return false
		}
		res.Body.Close()
		return res.StatusCode == http.StatusNoContent
	}, time.Second, 10*time.Millisecond)
	cancel()

	require.NoError(t, <-done)
}
