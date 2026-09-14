// Package mail sends the two transactional mails: sign-in links and
// invitations. Production goes through Resend; everything else logs the
// message so tests and local runs can follow the link from the log.
package mail

import (
	"context"
	"log/slog"
	"regexp"
)

type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

type Mailer interface {
	Send(ctx context.Context, m Message) error
}

// LogMailer never delivers. It logs the recipient, subject, and every link
// in the text body at INFO so the end-to-end suite can complete a sign-in.
type LogMailer struct {
	log *slog.Logger
}

func NewLogMailer(log *slog.Logger) *LogMailer { return &LogMailer{log: log} }

var linkRe = regexp.MustCompile(`https?://[^\s<>"]+`)

func (l *LogMailer) Send(_ context.Context, m Message) error {
	links := linkRe.FindAllString(m.Text, -1)
	l.log.Info("mail (not sent)", "to", m.To, "subject", m.Subject, "links", links)
	return nil
}
