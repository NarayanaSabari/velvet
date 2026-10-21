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

## Link a repository

```bash
cd my-repo
velvet init                       # or: velvet init --server https://velvet.example.com
```

`velvet init` opens your browser, where you sign in, confirm the code shown in the terminal, and pick one organisation and one project.
It then:

- writes `velvet.yaml` at the repository root, naming the server, organisation, and project;
- stores a new key for this repository in the system keychain (macOS Keychain, Secret Service on Linux, Credential Manager on Windows).

Commit `velvet.yaml`.
It holds no secret, and teammates run `velvet init` to get their own key for the same project.

The key can reach only that project.
The server enforces this, so editing `velvet.yaml` to name another project does not widen it: the CLI finds no key for the new name, and the old key is refused outside its project.
Tickets with no project are out of reach for every repository key.

Without a keychain (for example on a headless Linux box), keys go in `~/.config/velvet/credentials.json` with mode 0600, under hashed names.
Set `VELVET_NO_KEYCHAIN=1` to use that file even when a keychain exists.
In CI, set `VELVET_TOKEN` to a key and it is used instead of either store.

`velvet logout` revokes this repository's key on the server and removes it from this machine.
You can also revoke any key under Profile > API tokens.

## Commands

```text
velvet init [--server URL]              Link this repository to one Velvet project
velvet whoami                           Show the organisation, project, and person
velvet logout                           Revoke this repository's key on this machine

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
- `3`: not signed in, or the key was revoked; run `velvet init`.
- `4`: not found.
- `5`: network failure.
- `6`: another API error.
- `7`: outside this repository's project.
- `78`: no `velvet.yaml`, or an invalid one.

## Development

```bash
go vet ./... && go test ./...
```

`e2e/tests/cli.spec.ts` builds this binary and drives `velvet init`, browser approval, logging, scope refusal, and `install.sh` against the real stack.
