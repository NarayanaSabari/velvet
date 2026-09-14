package mail

import (
	"bytes"
	"fmt"
	"html/template"
)

var signInHTML = template.Must(template.New("signin").Parse(`<p>Click to sign in. The link works once and expires in 15 minutes.</p>
<p><a href="{{.Link}}">Sign in</a></p>
<p>If you did not request this, ignore this mail.</p>`))

var inviteHTML = template.Must(template.New("invite").Parse(`<p>{{.Inviter}} invited you to <strong>{{.Org}}</strong>.</p>
<p><a href="{{.Link}}">Accept the invitation</a></p>
<p>The link expires in 7 days.</p>`))

func SignInMessage(to, link string) Message {
	var html bytes.Buffer
	_ = signInHTML.Execute(&html, map[string]string{"Link": link})
	return Message{
		To:      to,
		Subject: "Your sign-in link",
		Text:    fmt.Sprintf("Click to sign in. The link works once and expires in 15 minutes.\n\n%s\n\nIf you did not request this, ignore this mail.\n", link),
		HTML:    html.String(),
	}
}

func InviteMessage(to, orgName, inviterName, link string) Message {
	var html bytes.Buffer
	_ = inviteHTML.Execute(&html, map[string]string{"Org": orgName, "Inviter": inviterName, "Link": link})
	return Message{
		To:      to,
		Subject: fmt.Sprintf("%s invited you to %s", inviterName, orgName),
		Text:    fmt.Sprintf("%s invited you to %s.\n\nAccept the invitation:\n%s\n\nThe link expires in 7 days.\n", inviterName, orgName, link),
		HTML:    html.String(),
	}
}
