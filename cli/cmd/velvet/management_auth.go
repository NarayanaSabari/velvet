package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/client"
	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

func managementIdentity(api *client.Client, account string) (identity, error) {
	me, err := readIdentity(api)
	if err != nil {
		return me, err
	}
	if me.TokenKind != "personal" || me.Scope != nil || me.User.ID == "" || (account != "" && me.User.ID != account) {
		return me, fail(exitAuth, "management commands require a separately approved account credential; run velvet admin login")
	}
	return me, nil
}

// loadManagementEnv never reads repository YAML, setup credentials, or bearer
// environment overrides. A repository cannot select account-wide authority.
func loadManagementEnv(server, account string, out, errOut io.Writer) (*env, error) {
	base, err := accountServer(server)
	if err != nil {
		return nil, err
	}
	user, token, err := (config.Keys{}).Management(base, account)
	if err != nil {
		return nil, fail(exitAuth, "%s", err)
	}
	api := client.New(base, token, version)
	if _, err := managementIdentity(api, user); err != nil {
		return nil, fmt.Errorf("management authentication failed; run velvet admin login: %w", err)
	}
	return &env{repo: config.Repo{Link: config.Link{Server: base}}, api: api, out: out, errOut: errOut}, nil
}

func cmdAdmin(args []string, out, errOut io.Writer, in io.Reader) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(out, "Usage: velvet admin (login|whoami|logout|members|invites|organisation|projects|github|reports|mentions) ...\nAccount-wide operations require separate browser consent through velvet admin login. Repository credentials are never used.")
		fmt.Fprint(out, adminUsage)
		return nil
	}
	if args[0] != "login" && args[0] != "logout" && args[0] != "whoami" {
		return runAdminCommand(args, out, errOut, in)
	}
	command := args[0]
	fs := flag.NewFlagSet("admin "+command, flag.ContinueOnError)
	fs.SetOutput(errOut)
	server := fs.String("server", "", "trusted server URL, never read from velvet.yaml")
	account := fs.String("account", "", "management account user ID")
	noBrowser := fs.Bool("no-browser", false, "print management consent URL instead of opening browser")
	yes := fs.Bool("yes", false, "confirm management credential revocation")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return fail(exitUsage, "%s", err)
	}
	if fs.NArg() != 0 || (*noBrowser && command != "login") || (*yes && command != "logout") {
		return fail(exitUsage, "unexpected admin %s arguments", command)
	}
	if command == "logout" && !*yes {
		return fail(exitUsage, "revoking management access requires velvet admin logout --yes; setup and project keys stay unchanged")
	}
	base, err := accountServer(*server)
	if err != nil {
		return err
	}
	keys := config.Keys{}
	if command == "login" {
		user, token, storedErr := keys.Management(base, *account)
		if storedErr == nil {
			me, err := managementIdentity(client.New(base, token, version), user)
			if err == nil {
				fmt.Fprintf(out, "Management access already approved for %s (%s) on %s.\n", displayName(me), user, base)
				return nil
			}
			var ee exitError
			if !errors.As(err, &ee) || ee.code != exitAuth {
				return err
			}
		} else if !errors.Is(storedErr, config.ErrNoManagement) {
			return fail(exitConfig, "%s", storedErr)
		}
		fmt.Fprintln(out, "Management access is account-wide and subject to your organisation roles. It is separate from repository setup and work keys.")
		api, err := deviceLogin(base, "manage", "personal", *noBrowser, out)
		if err != nil {
			return err
		}
		me, err := managementIdentity(api, *account)
		if err != nil {
			return revokeAfterFailure(api, err)
		}
		where, err := keys.SaveManagement(base, me.User.ID, api.Token)
		if err != nil {
			return revokeAfterFailure(api, fail(exitConfig, "could not store management credential: %s", err))
		}
		fmt.Fprintf(out, "Approved management access for %s (%s) on %s.\nStored separate account credential in %s. Repository keys remain project-scoped.\n", displayName(me), me.User.ID, base, where)
		return nil
	}
	e, err := loadManagementEnv(base, *account, out, errOut)
	if err != nil {
		return err
	}
	me, err := managementIdentity(e.api, *account)
	if err != nil {
		return err
	}
	if command == "whoami" {
		fmt.Fprintf(out, "Management account: %s (%s)\nServer: %s\nAccess: account-wide, subject to current organisation roles\n", displayName(me), me.User.ID, base)
		return nil
	}
	if err := e.api.Do(http.MethodDelete, "/me/token", nil, nil, nil); err != nil {
		return fmt.Errorf("management revocation failed; local credential retained: %w", apiError(err))
	}
	if err := keys.DeleteManagement(base, me.User.ID); err != nil {
		return fail(exitConfig, "management credential revoked on server but local removal failed: %s", err)
	}
	fmt.Fprintln(out, "Revoked management credential and removed its local copy. Setup access, project keys and velvet.yaml are unchanged.")
	return nil
}
