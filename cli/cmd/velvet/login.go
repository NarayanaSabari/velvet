package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/client"
	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

type identity struct {
	TokenKind string `json:"token_kind"`
	User      struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"user"`
	Memberships []membership `json:"memberships"`
	Scope       *struct {
		WorkspaceSlug string `json:"workspace_slug"`
		ProjectKey    string `json:"project_key"`
	} `json:"scope"`
}

type membership struct {
	Slug          string `json:"workspace_slug"`
	WorkspaceName string `json:"workspace_name"`
	IssuePrefix   string `json:"issue_prefix"`
	Role          string `json:"role"`
}

func readIdentity(api *client.Client) (identity, error) {
	var me identity
	if err := api.Do(http.MethodGet, "/me", nil, nil, &me); err != nil {
		return me, apiError(err)
	}
	return me, nil
}

func projectIdentity(api *client.Client, link config.Link) (identity, error) {
	me, err := readIdentity(api)
	if err != nil {
		return me, err
	}
	if me.TokenKind != "project" || me.Scope == nil {
		return me, fail(exitScope, "normal commands require a project-scoped key; personal and setup tokens are not allowed; run velvet init")
	}
	if me.Scope.WorkspaceSlug != link.Organisation || me.Scope.ProjectKey != link.Project {
		return me, fail(exitScope, "key scope does not match velvet.yaml; run velvet init --relink to confirm the intended project")
	}
	return me, nil
}

// accountServer never consults repository YAML: an edited file cannot select a
// machine setup credential or redirect it to another origin.
func accountServer(value string) (string, error) {
	if value == "" {
		value = os.Getenv("VELVET_SERVER")
	}
	if value == "" {
		value = defaultServer
	}
	value = strings.TrimRight(value, "/")
	if err := config.ValidateServer(value); err != nil {
		return "", fail(exitConfig, "%s", err)
	}
	return value, nil
}

func setupIdentity(api *client.Client, account string) (identity, error) {
	me, err := readIdentity(api)
	if err != nil {
		return me, err
	}
	if me.TokenKind != "setup" || me.Scope != nil || me.User.ID == "" || (account != "" && me.User.ID != account) {
		return me, fail(exitAuth, "stored login is not a setup credential for this account; run velvet login")
	}
	return me, nil
}

func cmdLogin(args []string, out, errOut io.Writer) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(errOut)
	server := fs.String("server", "", "server URL (default: VELVET_SERVER or "+defaultServer+")")
	noBrowser := fs.Bool("no-browser", false, "print the consent URL instead of opening a browser")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return fail(exitUsage, "%s", err)
	}
	if fs.NArg() != 0 {
		return fail(exitUsage, "usage: velvet login [--server URL] [--no-browser]")
	}
	base, err := accountServer(*server)
	if err != nil {
		return err
	}
	keys := config.Keys{}
	user, saved, loginErr := keys.Login(base, "")
	if loginErr == nil {
		me, verifyErr := setupIdentity(client.New(base, saved, version), user)
		if verifyErr == nil {
			fmt.Fprintf(out, "Already signed in as %s (%s). Run velvet init in a project directory.\n", displayName(me), user)
			return nil
		}
		var ee exitError
		if !errors.As(verifyErr, &ee) || ee.code != exitAuth {
			return verifyErr
		}
	} else if !errors.Is(loginErr, config.ErrNoLogin) {
		return fail(exitConfig, "%s", loginErr)
	}
	api := client.New(base, "", version)
	host, _ := os.Hostname()
	var start struct {
		DeviceCode      string    `json:"device_code"`
		UserCode        string    `json:"user_code"`
		VerificationURI string    `json:"verification_uri_complete"`
		ExpiresAt       time.Time `json:"expires_at"`
		Interval        int       `json:"interval"`
	}
	if err := api.Do(http.MethodPost, "/cli/sessions", nil, map[string]string{"client_name": "velvet CLI on " + host, "flow": "login"}, &start); err != nil {
		return apiError(err)
	}
	consent, parseErr := url.Parse(start.VerificationURI)
	origin, _ := url.Parse(base)
	if start.DeviceCode == "" || start.UserCode == "" || parseErr != nil || consent.Scheme != origin.Scheme || consent.Host != origin.Host || consent.User != nil {
		return fail(exitAPI, "server returned an invalid device consent response")
	}
	fmt.Fprintf(out, "Sign in through your browser:\n\n  %s\n\nConfirm the code shown there is %s.\n", start.VerificationURI, start.UserCode)
	if !*noBrowser {
		openBrowser(start.VerificationURI)
	}
	fmt.Fprintln(out, "\nWaiting for approval…")
	var grant struct {
		Token string `json:"token"`
		Kind  string `json:"kind"`
	}
	deadline := start.ExpiresAt
	if deadline.IsZero() {
		deadline = time.Now().Add(10 * time.Minute)
	}
	for {
		if !time.Now().Before(deadline) {
			return fail(exitAuth, "sign-in expired; run velvet login again")
		}
		time.Sleep(time.Duration(max(start.Interval, 1)) * time.Second)
		err := api.Do(http.MethodPost, "/cli/sessions/token", nil, map[string]string{"device_code": start.DeviceCode}, &grant)
		if err == nil {
			break
		}
		var ce *client.Error
		if errors.As(err, &ce) {
			switch ce.Code {
			case "authorization_pending":
				continue
			case "access_denied":
				return fail(exitAuth, "sign-in was refused in the browser")
			case "expired_token":
				return fail(exitAuth, "sign-in expired; run velvet login again")
			}
		}
		return apiError(err)
	}
	if grant.Kind != "setup" || grant.Token == "" {
		return fail(exitAuth, "server did not issue a setup credential")
	}
	api.Token = grant.Token
	me, err := setupIdentity(api, "")
	if err != nil {
		return revokeAfterFailure(api, err)
	}
	where, err := keys.SaveLogin(base, me.User.ID, grant.Token)
	if err != nil {
		return revokeAfterFailure(api, fail(exitConfig, "could not store login: %s", err))
	}
	fmt.Fprintf(out, "Signed in as %s (%s).\nStored machine setup credential in %s. Run velvet init in a project directory.\n", displayName(me), me.User.ID, where)
	return nil
}

func displayName(me identity) string {
	if me.User.Name != "" {
		return me.User.Name
	}
	return me.User.Email
}

func cmdIdentity(command string, args []string, out, errOut io.Writer) error {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(errOut)
	server := fs.String("server", "", "server URL (default: VELVET_SERVER or "+defaultServer+")")
	account := fs.String("account", "", "account user ID (default: last login on this server)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return fail(exitUsage, "%s", err)
	}
	if fs.NArg() != 0 {
		return fail(exitUsage, "unexpected arguments")
	}
	if command != "logout" && *server == "" && *account == "" {
		wd, err := os.Getwd()
		if err != nil {
			return err
		}
		_, err = config.Find(wd)
		if err == nil {
			e, err := loadEnv(out, errOut)
			if err != nil {
				return err
			}
			me, err := projectIdentity(e.api, e.repo.Link)
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "Signed in as %s (%s)\nServer: %s\nOrganisation: %s\nProject: %s\nKey: limited to this project\n", displayName(me), me.User.ID, e.repo.ServerURL(), e.repo.Organisation, e.repo.Project)
			for _, m := range me.Memberships {
				fmt.Fprintf(out, "Role: %s\n", m.Role)
			}
			return nil
		}
		if !errors.Is(err, config.ErrNotInitialised) {
			return fail(exitConfig, "%s", err)
		}
	}
	base, err := accountServer(*server)
	if err != nil {
		return err
	}
	keys := config.Keys{}
	user, token, err := keys.Login(base, *account)
	if err != nil {
		return fail(exitAuth, "%s", err)
	}
	api := client.New(base, token, version)
	if command == "logout" {
		// Do not claim server revocation after a network/authorization failure, or
		// delete the only local credential capable of retrying the revocation.
		if err := api.Do(http.MethodDelete, "/me/token", nil, nil, nil); err != nil {
			return fmt.Errorf("logout failed; local login retained, server revocation not confirmed: %w", apiError(err))
		}
		if err := keys.DeleteLogin(base, user); err != nil {
			return fail(exitConfig, "machine login and descendants revoked on server, but local removal failed: %s", err)
		}
		fmt.Fprintln(out, "Revoked machine login and all its project keys on the server. Removed local login and matching cached project keys; velvet.yaml is unchanged.")
		return nil
	}
	me, err := setupIdentity(api, user)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Signed in as %s (%s)\nServer: %s\nKey: machine setup only, not for work commands\n", displayName(me), user, base)
	for _, m := range me.Memberships {
		fmt.Fprintf(out, "Organisation: %s (%s), ticket keys %s-N\nRole: %s\n", m.WorkspaceName, m.Slug, m.IssuePrefix, m.Role)
	}
	return nil
}

func revokeAfterFailure(api *client.Client, cause error) error {
	if err := api.Do(http.MethodDelete, "/me/token", nil, nil, nil); err != nil {
		return fmt.Errorf("%w; rollback revocation failed: %v", cause, err)
	}
	return cause
}
