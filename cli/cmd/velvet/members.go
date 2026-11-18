package main

import (
	"fmt"
	"net/http"
	"strings"
	"text/tabwriter"
)

type member struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	Name        string  `json:"name"`
	GitHubLogin *string `json:"github_login"`
}

func (m member) label() string {
	if m.Name != "" {
		return m.Name + " <" + m.Email + ">"
	}
	return m.Email
}

func (e env) listMembers() ([]member, error) {
	var out struct {
		Members []member `json:"members"`
	}
	if err := e.api.Do(http.MethodGet, e.scoped("/members"), nil, nil, &out); err != nil {
		return nil, apiError(err)
	}
	return out.Members, nil
}

func (e env) members(args []string) error {
	if len(args) != 0 {
		return fail(exitUsage, "usage: velvet members")
	}
	list, err := e.listMembers()
	if err != nil {
		return err
	}
	w := tabwriter.NewWriter(e.out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tEMAIL\tGITHUB\tID")
	for _, m := range list {
		gh := ""
		if m.GitHubLogin != nil {
			gh = *m.GitHubLogin
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", m.Name, m.Email, gh, m.ID)
	}
	return w.Flush()
}

// resolveAssignee turns "none", "me", a UUID, an email, a GitHub login or part
// of a name into a user ID. nil means clear. It never guesses between people.
func (e env) resolveAssignee(value string) (*string, error) {
	value = strings.TrimSpace(value)
	switch {
	case value == "none":
		return nil, nil
	case ticketUUID.MatchString(value):
		return &value, nil
	case value == "":
		return nil, fail(exitUsage, "--assignee needs a name, email, me, UUID or none")
	}
	if value == "me" {
		var me struct {
			User struct {
				ID string `json:"id"`
			} `json:"user"`
		}
		if err := e.api.Do(http.MethodGet, "/me", nil, nil, &me); err != nil {
			return nil, apiError(err)
		}
		return &me.User.ID, nil
	}
	list, err := e.listMembers()
	if err != nil {
		return nil, err
	}
	m, err := matchMember(list, value)
	if err != nil {
		return nil, err
	}
	return &m.ID, nil
}

// matchMember prefers an exact email or GitHub login, then a unique substring
// of name or email.
func matchMember(list []member, query string) (member, error) {
	q := strings.ToLower(query)
	for _, m := range list {
		if strings.ToLower(m.Email) == q || (m.GitHubLogin != nil && strings.ToLower(*m.GitHubLogin) == q) {
			return m, nil
		}
	}
	var hits []member
	for _, m := range list {
		if strings.Contains(strings.ToLower(m.Name), q) || strings.Contains(strings.ToLower(m.Email), q) {
			hits = append(hits, m)
		}
	}
	switch len(hits) {
	case 1:
		return hits[0], nil
	case 0:
		return member{}, fail(exitUsage, "no member matches %q; run velvet members", query)
	}
	names := make([]string, len(hits))
	for i, m := range hits {
		names[i] = m.label()
	}
	return member{}, fail(exitUsage, "%q matches %d members: %s. Use the email", query, len(hits), strings.Join(names, ", "))
}
