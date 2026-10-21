# velvet CLI

`velvet` keeps a Velvet work log from a repository.
It is one Go binary with no runtime dependencies, and it is how coding agents write to Velvet.

## Install

```bash
curl -fsSL https://velvet.sabarinarayana.com/install.sh | sh
```

For a self-hosted server, set `VELVET_SERVER` so the binary comes from it:

```bash
curl -fsSL https://velvet.example.com/install.sh | VELVET_SERVER=https://velvet.example.com sh
```

The script picks the build for macOS or Linux on arm64 or amd64, checks it against the server's `SHA256SUMS`, and installs it to `~/.local/bin` (override with `VELVET_INSTALL_DIR`).

Each build is stamped with the commit it was built from, shown by `velvet --version`.
Run `velvet update` to install the server's current build after the same checksum check, or `velvet update --check` to only compare.
It updates from `--server`, then `VELVET_SERVER`, then the repository's `velvet.yaml`, then the hosted Velvet.
To build from source instead, run `go build -o velvet ./cmd/velvet` in this folder.

## Sign in, then link a directory

```bash
velvet login                     # opens browser consent once
cd my-repo
velvet init                      # terminal-only organisation/project setup
```

For a self-hosted server, pass `--server https://velvet.example.com` to login and init, or set `VELVET_SERVER`.
Login never reads or writes `velvet.yaml` and works outside repositories.
It asks you to confirm the device code in your browser, then stores a machine setup credential for that server and account.
A valid saved login is reused, so repeated login does not mint orphan machine credentials.
Use `--no-browser` on **login** to print the consent URL without opening it.
Setup credentials permit identity and organisation/project setup only. They cannot read or write work data.

`velvet init` never opens a browser.
It lets you choose an organisation where you are an admin or member, or create one, then choose or create a project.
It shows the server, account, organisation, project, and config destination for confirmation.
A naming conflict keeps the entered name and asks for another slug or key.
If no login exists, it tells you to run `velvet login` instead of starting browser consent.

For scripts, select existing resources explicitly:

```bash
velvet init --server https://velvet.example.com \
  --organisation lab --project web --non-interactive
```

To create resources, add `--create-organisation "Lab" --issue-prefix LAB` and/or `--create-project "Web"`.
The `--organisation` slug and `--project` key remain required when using their creation flags.
`--non-interactive` never prompts. Without complete selections it fails with actionable flag guidance.
`--account USER_ID` selects another saved account explicitly. A cached project key from another account requires confirmed `--relink` before replacement.

Init exchanges the setup credential at `POST /api/v1/cli/project-tokens` for a key limited to exactly the selected organisation and project.
It reuses an existing valid project key rather than rotating it on each run.
It writes `velvet.yaml` in the **invocation directory**, not the Git root, and stores the project key separately.
YAML writes use atomic replacement. Persistence failures restore prior local configuration and credentials, and attempt to revoke a newly issued key.
A failed rollback is reported, never presented as a successful setup.
Organisations or projects explicitly created before cancellation or a later failure remain on the server.

Commit `velvet.yaml`. It holds no secret, and teammates run login and init with their own account.
Existing three-field YAML and project credentials remain supported: run `velvet init` once to confirm a legacy or cloned directory.
A valid legacy project key can be reused without browser login.
Normal commands never silently adopt a cached key based on unbound YAML.

### Private credentials and bindings

Credentials use the system keychain (macOS Keychain, Secret Service on Linux, Credential Manager on Windows).
Without a keychain, they use a 0600 `credentials.json` in the OS user-config directory's `velvet` folder.
On Linux this is normally `~/.config/velvet/credentials.json`.
Set `VELVET_NO_KEYCHAIN=1` to force the private file store.
Entry identifiers are hashed. Private directory bindings and cleanup metadata may include server and project names, but never go in repository YAML.

Each confirmed directory has a separate private binding to its canonical filesystem path and project.
Editing YAML cannot switch to another cached credential, even when that credential exists.
Symlink aliases share the same binding, and child directories honor the nearest private ancestor binding.
Changing the project requires explicit confirmation:

```bash
velvet init --organisation lab --project other --relink
# Scripts must also pass --yes --non-interactive.
```

Every normal command checks `/me` for token kind `project` and an exact organisation/project scope before work requests.
Personal and setup credentials are refused, including through `VELVET_TOKEN`.
In CI, use a project-scoped `VELVET_TOKEN` and pin `VELVET_SERVER` to the YAML server, especially for unbound checkouts.
An unbound CI checkout without `VELVET_SERVER` trusts only the hosted default server.
API redirects are not followed with credentials.

These checks prevent accidental credential selection and YAML tampering, not a malicious process running as the same OS user.
Such a process may access the setup key directly. Use a separate OS identity or credential broker for that isolation boundary.

### Identity and logout

`velvet whoami` shows the bound project identity inside an initialized directory, and machine login identity outside one.
Pass `--server URL` and optionally `--account USER_ID` to inspect a saved machine login regardless of the current directory.
The `where` and `me` aliases retain the same contextual behavior.
Account commands never select a setup credential from editable repository YAML.

`velvet logout --server URL` works outside repositories.
It revokes that account's machine setup credential and all descendant project keys on the server, then removes the local login and matching cached descendants.
Other servers, accounts, YAML files, and directory bindings are preserved.
If a cached project slot was replaced by another account, logout leaves that replacement alone.
If server revocation fails, logout reports the failure and keeps the local login so you can retry.
If local removal fails after confirmed revocation, it reports that distinction.
Legacy project credentials that were not issued by this machine login are not its descendants. Revoke those separately under Profile > API tokens.
To switch the active account, log out, then run login again.

## Commands

```text
velvet login [--server URL] [--no-browser] Sign in once through browser consent
velvet init [--server URL] [--organisation SLUG] [--project KEY] [--non-interactive]
                                        Link this directory in the terminal
velvet whoami [--server URL] [--account ID] Show project or machine login identity
velvet logout [--server URL] [--account ID] Revoke machine login and its project keys

velvet log [KEY] [--kind K] BODY        Log work on a ticket, or on the project without KEY
velvet attach KEY REFERENCE             Attach a PR URL, owner/repo#N, or commit sha
velvet recap [--days N]                 Summarise recent work in this project

velvet issues [--status S] [--mine]     List this project's tickets
velvet issue KEY                        Show a ticket and its recent work log
velvet new TITLE [--desc D] [--milestone ID] [--priority N]
velvet status KEY STATUS                Change a ticket's status (only when asked)
velvet key-from-branch                  Print the ticket key named by the current branch

velvet sprints [new NAME FROM TO]       List or create this project's sprints
velvet milestones [SPRINT_ID | new SPRINT_ID NAME]
velvet upload-image (KEY | --milestone ID) PATH --caption TEXT
```

`log` reads the entry from standard input when no body is given.
Flags go before the body, for example `velvet log ENG-42 --kind decision "Keep the CLI dependency-free."`.
`--kind` is one of `progress`, `decision`, `blocker`, or `note`.

`upload-image` sends one regular local file of at most 10 MiB.
The server checks it really is a PNG, JPEG, or WebP image.
Uploads never change a ticket's status.

The CLI never changes a status unless `velvet status` is run, and never reports time spent.

## Examples

```bash
KEY="$(velvet key-from-branch)"          # sabari/eng-42-fix-auth -> ENG-42
velvet issue "$KEY"
velvet log "$KEY" "Fixed the Authorization header handling."
printf '%s\n' 'Decided to keep retries in the client.' | velvet log "$KEY" --kind decision
velvet attach "$KEY" https://github.com/acme/web/pull/7
velvet log "Set up CI caching for the project."
velvet new "Document key rotation" --desc "Add the operator runbook" --priority 2
```

## Exit codes

- `0`: success.
- `2`: invalid command or arguments.
- `3`: not signed in, or the key was revoked. Run `velvet login`, then `velvet init` for project setup.
- `4`: not found.
- `5`: network failure.
- `6`: another API error.
- `7`: outside this repository's project.
- `78`: no `velvet.yaml`, an invalid one, an unconfirmed directory, or a private binding mismatch.

## Development

```bash
go vet ./... && go test ./...
```

`e2e/tests/cli.spec.ts` builds this binary and drives login browser consent, terminal-only init, project creation, logging, scope refusal, logout cascading, and `install.sh` against the real stack.
