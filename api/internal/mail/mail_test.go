package mail

import (
	"bytes"
	"context"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLogMailerWritesLinks(t *testing.T) {
	var buf bytes.Buffer
	m := NewLogMailer(slog.New(slog.NewTextHandler(&buf, nil)))
	require.NoError(t, m.Send(context.Background(), SignInMessage("a@example.com", "https://x/api/v1/auth/magic?token=abc")))
	out := buf.String()
	require.Contains(t, out, "a@example.com")
	require.Contains(t, out, "https://x/api/v1/auth/magic?token=abc")
}

func TestTemplates(t *testing.T) {
	s := SignInMessage("a@example.com", "https://x/m")
	require.Equal(t, "Your sign-in link", s.Subject)
	require.Contains(t, s.Text, "https://x/m")
	require.Contains(t, s.HTML, `href="https://x/m"`)

	i := InviteMessage("b@example.com", "Velvet", "Sabari", "https://x/invite/t")
	require.Equal(t, "Sabari invited you to Velvet", i.Subject)
	require.Contains(t, i.Text, "https://x/invite/t")
	// Names are escaped in HTML so an inviter cannot inject markup.
	j := InviteMessage("b@example.com", "<b>x</b>", "A", "https://x")
	require.NotContains(t, j.HTML, "<b>x</b>")
}
