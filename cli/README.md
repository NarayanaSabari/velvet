# Velvet CLI

`cli/velvet` is a portable Bash CLI for the Velvet work-log API.
It only needs `curl`, `python3`, and standard POSIX utilities available on macOS.

## Configuration

Set these environment variables before calling a workspace command:

- `VELVET_URL`: the server URL, without `/api/v1`, such as `https://worklog.example.com`.
- `VELVET_TOKEN`: a personal API token beginning with `velvet_`.
- `VELVET_WORKSPACE`: the workspace slug, such as `engineering`.

Keep the token out of files and shell history where possible.
The recommended approach is to store it in envkit and run the command through envkit:

```bash
envkit run -- velvet me
envkit run -- velvet issues --mine
```

When using the checkout directly, replace `velvet` with `./cli/velvet`:

```bash
envkit run -- ./cli/velvet me
```

Do not create a `.env` file for the token.

## Commands

```text
velvet me
velvet issues [--status STATUS] [--mine]
velvet issue KEY
velvet new TITLE [--desc TEXT] [--status STATUS] [--priority N] [--milestone ID]
velvet log KEY [BODY ...]
velvet status KEY STATUS
velvet key-from-branch
```

`me` checks authentication and does not require `VELVET_WORKSPACE`.
`issues --mine` resolves the authenticated user's ID through `me` and sends the API's `assignee_id` filter.
`issue` prints the issue and its ten most recent comments.
`log` joins body arguments with spaces, or reads the complete note from standard input when no body argument is supplied.
`key-from-branch` prints the first issue key in the current Git branch in uppercase and exits 1 when none is present.
Every command accepts `--help`.

## Examples

```bash
# Use a branch such as sabari/eng-42-fix-auth to find the ticket.
KEY="$(velvet key-from-branch)"

velvet issues --status in_progress
velvet issue "$KEY"
velvet log "$KEY" "I fixed the Authorization header handling."
printf '%s\n' 'I decided to keep the CLI dependency-free.' | velvet log "$KEY"
velvet status "$KEY" in_review
velvet new "Document API token rotation" --desc "Add the operator runbook" --priority 2
```

The CLI never changes a ticket status unless the explicit `status` command is run.
It does not report or infer time spent.

## Exit codes

- `0`: success.
- `2`: invalid command or arguments.
- `3`: authentication or permission failure, including HTTP 401.
- `4`: resource not found, including HTTP 404.
- `5`: network or transport failure.
- `6`: another API failure.
- `78`: missing or invalid local configuration.
