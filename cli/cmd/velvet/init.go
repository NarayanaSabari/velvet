package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/client"
	"github.com/NarayanaSabari/velvet-otter-lab/cli/internal/config"
)

type terminal struct {
	in             *bufio.Reader
	out            io.Writer
	nonInteractive bool
}

func (t terminal) confirm(link config.Link, account, dir string) error {
	fmt.Fprintf(t.out, "Server: %s\nAccount: %s\nOrganisation: %s\nProject: %s\nConfig: %s\n", link.ServerURL(), account, link.Organisation, link.Project, filepath.Join(dir, config.FileName))
	if t.nonInteractive {
		return nil
	}
	answer, err := t.ask("Link this directory? Type yes")
	if err != nil {
		return err
	}
	if answer != "yes" {
		return fail(exitUsage, "init cancelled; no project key or directory config was changed")
	}
	return nil
}

func (t terminal) ask(label string) (string, error) {
	if t.nonInteractive {
		return "", fail(exitUsage, "%s required in noninteractive mode; pass explicit init flags", label)
	}
	fmt.Fprintf(t.out, "%s: ", label)
	line, err := t.in.ReadString('\n')
	if err != nil && (err != io.EOF || line == "") {
		return "", fail(exitUsage, "no input for %s; pass explicit init flags", label)
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return "", fail(exitUsage, "%s must not be empty", label)
	}
	return line, nil
}

func (t terminal) choose(label string, names []string) (int, error) {
	if t.nonInteractive {
		return 0, fail(exitUsage, "--%s is required in noninteractive mode", strings.ToLower(label))
	}
	for i, name := range names {
		fmt.Fprintf(t.out, "  %d. %s\n", i+1, name)
	}
	fmt.Fprintf(t.out, "  0. Create %s\n", strings.ToLower(label))
	value, err := t.ask(label + " number")
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 || n > len(names) {
		return 0, fail(exitUsage, "choose a number between 0 and %d", len(names))
	}
	return n, nil
}

func cmdInit(args []string, out, errOut io.Writer, in io.Reader) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	fs.SetOutput(errOut)
	server := fs.String("server", "", "server URL (default: existing velvet.yaml, VELVET_SERVER or hosted Velvet)")
	organisation := fs.String("organisation", "", "organisation slug")
	project := fs.String("project", "", "project key")
	createOrg := fs.String("create-organisation", "", "create organisation with this name, requires --organisation and --issue-prefix")
	prefix := fs.String("issue-prefix", "", "2 to 6 uppercase letters for a new organisation")
	createProject := fs.String("create-project", "", "create project with this name, requires --project")
	account := fs.String("account", "", "setup account user ID (default: last login on server)")
	nonInteractive := fs.Bool("non-interactive", false, "never prompt; require explicit selections")
	relink := fs.Bool("relink", false, "explicitly allow a different private directory binding")
	yes := fs.Bool("yes", false, "confirm --relink without a prompt")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return fail(exitUsage, "%s", err)
	}
	if fs.NArg() != 0 {
		return fail(exitUsage, "unexpected init arguments")
	}
	if *yes && !*relink {
		return fail(exitUsage, "--yes requires --relink")
	}
	if *createOrg != "" && (*organisation == "" || *prefix == "") {
		return fail(exitUsage, "--create-organisation requires --organisation SLUG and --issue-prefix PREFIX")
	}
	if *createProject != "" && *project == "" {
		return fail(exitUsage, "--create-project requires --project KEY")
	}
	wd, err := os.Getwd()
	if err != nil {
		return err
	}
	keys := config.Keys{}
	existing, findErr := config.Find(wd)
	if findErr != nil && !errors.Is(findErr, config.ErrNotInitialised) {
		return fail(exitConfig, "%s", findErr)
	}
	t := terminal{bufio.NewReader(in), out, *nonInteractive}
	if *relink && !*yes {
		answer, err := t.ask("Relink this directory and replace its private project binding? Type yes")
		if err != nil {
			return err
		}
		if answer != "yes" {
			return fail(exitUsage, "relink cancelled; directory is unchanged")
		}
	}
	if findErr == nil && !*relink {
		if err := keys.CheckBinding(wd, existing.Link); err != nil {
			return fail(exitConfig, "%s", err)
		}
	}
	base := *server
	if base == "" && findErr == nil {
		base = existing.ServerURL()
	}
	base, err = accountServer(base)
	if err != nil {
		return err
	}
	link := config.Link{Server: base, Organisation: *organisation, Project: *project}
	if findErr == nil {
		if link.Organisation == "" {
			link.Organisation = existing.Organisation
		}
		if link.Project == "" {
			link.Project = existing.Project
		}
	}
	// A setup credential must not be loaded or sent until the existing private
	// binding agrees, even if an edited YAML selects a server we also use.
	if !*relink {
		if err := keys.CheckBinding(wd, link); err != nil {
			return fail(exitConfig, "%s", err)
		}
	}
	user, setup, loginErr := keys.Login(base, *account)
	if loginErr != nil && !errors.Is(loginErr, config.ErrNoLogin) {
		return fail(exitConfig, "%s", loginErr)
	}
	if link.Organisation != "" && link.Project != "" && *createOrg == "" && *createProject == "" {
		if err := link.Validate(); err != nil {
			return fail(exitConfig, "%s", err)
		}
		token, err := keys.LoadStored(link)
		if err == nil {
			projectMe, verifyErr := projectIdentity(client.New(base, token, version), link)
			if verifyErr == nil {
				if (user == "" || projectMe.User.ID == user) && (*account == "" || projectMe.User.ID == *account) {
					if err := t.confirm(link, projectMe.User.ID, wd); err != nil {
						return err
					}
					return writeLink(keys, wd, link, out, "Reused the valid project key")
				}
				if !*relink {
					return fail(exitAuth, "cached project key belongs to another account; run velvet init --relink to confirm replacement")
				}
			} else {
				var ee exitError
				if !errors.As(verifyErr, &ee) || ee.code != exitAuth {
					return verifyErr
				}
			}
		} else if !errors.Is(err, config.ErrNoKey) {
			return fail(exitConfig, "%s", err)
		}
	}
	if loginErr != nil {
		return fail(exitAuth, "%s; run velvet login --server %s", loginErr, base)
	}
	api := client.New(base, setup, version)
	me, err := setupIdentity(api, user)
	if err != nil {
		return err
	}
	if link.Organisation == "" {
		eligible := me.Memberships[:0]
		for _, m := range me.Memberships {
			if m.Role == "admin" || m.Role == "member" {
				eligible = append(eligible, m)
			}
		}
		me.Memberships = eligible
		names := make([]string, len(me.Memberships))
		for i, m := range me.Memberships {
			names[i] = m.WorkspaceName + " (" + m.Slug + ")"
		}
		n, err := t.choose("Organisation", names)
		if err != nil {
			return err
		}
		if n == 0 {
			*createOrg, err = t.ask("Organisation name")
			if err != nil {
				return err
			}
			link.Organisation, err = t.ask("Organisation slug")
			if err != nil {
				return err
			}
			*prefix, err = t.ask("Issue prefix")
			if err != nil {
				return err
			}
		} else {
			link.Organisation = me.Memberships[n-1].Slug
		}
	}
	if *createOrg != "" {
		for {
			err := api.Do(http.MethodPost, "/orgs", nil, map[string]string{"name": *createOrg, "slug": link.Organisation, "issue_prefix": *prefix}, nil)
			if err == nil {
				break
			}
			if client.StatusOf(err) != http.StatusConflict || *nonInteractive {
				return apiError(err)
			}
			fmt.Fprintln(out, "Organisation slug already exists. Choose another slug; the name and issue prefix are retained.")
			link.Organisation, err = t.ask("Organisation slug")
			if err != nil {
				return err
			}
		}
	}
	path := "/w/" + url.PathEscape(link.Organisation) + "/projects"
	if link.Project == "" {
		var list struct {
			Projects []struct {
				Key  string `json:"key"`
				Name string `json:"name"`
			} `json:"projects"`
		}
		if err := api.Do(http.MethodGet, path, nil, nil, &list); err != nil {
			return apiError(err)
		}
		names := make([]string, len(list.Projects))
		for i, p := range list.Projects {
			names[i] = p.Name + " (" + p.Key + ")"
		}
		n, err := t.choose("Project", names)
		if err != nil {
			return err
		}
		if n == 0 {
			*createProject, err = t.ask("Project name")
			if err != nil {
				return err
			}
			link.Project, err = t.ask("Project key")
			if err != nil {
				return err
			}
		} else {
			link.Project = list.Projects[n-1].Key
		}
	}
	if err := link.Validate(); err != nil {
		return fail(exitConfig, "%s", err)
	}
	if !*relink {
		if err := keys.CheckBinding(wd, link); err != nil {
			return fail(exitConfig, "%s", err)
		}
	}
	if *createProject != "" {
		for {
			err := api.Do(http.MethodPost, path, nil, map[string]string{"name": *createProject, "key": link.Project}, nil)
			if err == nil {
				break
			}
			if client.StatusOf(err) != http.StatusConflict || *nonInteractive {
				return apiError(err)
			}
			fmt.Fprintln(out, "Project key already exists. Choose another key; the project name is retained.")
			link.Project, err = t.ask("Project key")
			if err != nil {
				return err
			}
		}
	}
	if err := link.Validate(); err != nil {
		return fail(exitConfig, "%s", err)
	}
	if !*relink {
		if err := keys.CheckBinding(wd, link); err != nil {
			return fail(exitConfig, "%s", err)
		}
	}
	if err := t.confirm(link, user, wd); err != nil {
		return err
	}
	// Interactive selections may resolve to an already stored key too. Never
	// rotate a valid project credential merely because init ran again.
	if old, err := keys.LoadStored(link); err == nil {
		if projectMe, err := projectIdentity(client.New(base, old, version), link); err == nil {
			if projectMe.User.ID == user {
				return writeLink(keys, wd, link, out, "Reused the valid project key")
			}
			if !*relink {
				return fail(exitAuth, "cached project key belongs to another account; run velvet init --relink to confirm replacement")
			}
		}
	}
	var grant struct {
		Token         string `json:"token"`
		Kind          string `json:"kind"`
		WorkspaceSlug string `json:"workspace_slug"`
		ProjectKey    string `json:"project_key"`
	}
	if err := api.Do(http.MethodPost, "/cli/project-tokens", nil, map[string]string{"workspace_slug": link.Organisation, "project_key": link.Project}, &grant); err != nil {
		return apiError(err)
	}
	scoped := client.New(base, grant.Token, version)
	if grant.Kind != "project" || grant.Token == "" || grant.WorkspaceSlug != link.Organisation || grant.ProjectKey != link.Project {
		if grant.Token == "" {
			return fail(exitAPI, "server returned an invalid project grant")
		}
		return revokeAfterFailure(scoped, fail(exitAPI, "server returned an invalid project grant"))
	}
	projectMe, err := projectIdentity(scoped, link)
	if err != nil {
		return revokeAfterFailure(scoped, err)
	}
	if projectMe.User.ID != user {
		return revokeAfterFailure(scoped, fail(exitAuth, "issued project key belongs to a different account"))
	}
	old, oldErr := keys.LoadStored(link)
	if oldErr != nil && !errors.Is(oldErr, config.ErrNoKey) {
		return revokeAfterFailure(scoped, oldErr)
	}
	where, err := keys.Save(link, grant.Token)
	if err != nil {
		return revokeAfterFailure(scoped, fail(exitConfig, "could not store project key: %s", err))
	}
	if err := keys.TrackProject(link, user, grant.Token); err != nil {
		var restore error
		if oldErr == nil {
			_, restore = keys.Save(link, old)
		} else {
			restore = keys.Delete(link)
		}
		return revokeAfterFailure(scoped, errors.Join(fail(exitConfig, "could not track project credential: %s", err), restore))
	}
	if err := writeLink(keys, wd, link, out, "Stored project key in "+where); err != nil {
		var restore error
		if oldErr == nil {
			_, restore = keys.Save(link, old)
		} else {
			restore = keys.Delete(link)
		}
		return revokeAfterFailure(scoped, errors.Join(err, restore))
	}
	return nil
}

func writeLink(keys config.Keys, dir string, link config.Link, out io.Writer, detail string) error {
	path, err := keys.LinkDirectory(dir, link)
	if err != nil {
		return fail(exitConfig, "could not link directory: %s", err)
	}
	fmt.Fprintf(out, "Linked to %s in %s.\nWrote %s. Commit it so teammates link the same project.\n%s. It can reach only this project.\n", link.Project, link.Organisation, filepath.Clean(path), detail)
	return nil
}
