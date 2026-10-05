# Velvet MCP server

> Most people should use the hosted server instead, which needs nothing installed: point an agent at `https://<velvet>/api/v1/w/<organisation>/mcp` with `Authorization: Bearer <token>`, or follow the setup at `/onboarding`.
> This local stdio server remains for resolving the organisation from a checkout's git remote.

`velvet-mcp` is a private stdio MCP server that gives coding agents typed tools for the Velvet work-log API.
It uses the same `/api/v1` endpoints as [`cli/velvet`](../cli/velvet), without browser cookies or an `Origin` header.

## Image attachments

The local `velvet_upload_image` tool accepts `path`, `caption`, and exactly one of `key` or `milestone_id`.
Every upload requires a fresh host form-elicitation confirmation showing the absolute local path, resolved workspace, destination URL, and relevance caption.
The client must support form elicitation and return an accepted response with `confirm` exactly `true`.
There is no model-supplied approval argument, affirmative default, or remembered approval.
Clients advertising the legacy `elicitation: {}` capability are supported through the installed SDK's form-capability normalization.
Missing or URL-only capability, decline, cancel, malformed responses, elicitation request failures, and cancellation during confirmation fail closed before the file is opened or read and before any upload request.
The upload call itself does not discover a workspace or make network requests before confirmation.
Set `VELVET_WORKSPACE`, or first call `velvet_where_am_i` to resolve the checkout's workspace through its normal metadata request.
An unresolved upload destination is refused rather than guessed or discovered during upload.
Read-only tools such as `velvet_list_images` and `velvet_where_am_i` do not require elicitation.

`path` must explicitly name an existing regular local file no larger than 10 MiB.
Final symlinks, directories, special files, empty files, and files that grow beyond the bounded read are rejected.
After confirmation, a bounded read must have a PNG, JPEG, or WebP byte signature before multipart data is constructed or sent.
Cancellation is checked before metadata access, opening, allocation, and each bounded read, and after asynchronous file operations.
An already pending filesystem operation may finish, but cancellation stops subsequent reads and prevents the upload request, with the file handle always closed.
The tool's cancellation signal is also passed to the upload fetch.
Cancellation of an in-flight upload is best effort and cannot undo a request the API has already committed.
Check the target's attachments before retrying an interrupted upload rather than assuming it was not saved.
This lightweight signature filter rejects ordinary non-image files even with an image extension, but is not full decoding or metadata sanitization.
Only that file is read, with native `FormData` and authenticated `fetch` sending multipart `file` and `caption` to the target's `/images` API.
The API remains responsible for decoding image bytes, enforcing dimensions and animation rules, sanitizing metadata, and validating target permissions.
No remote URL fetch, image base64, or model-generated image output is involved.
`velvet_list_images` accepts exactly one of `key` or `milestone_id` and returns metadata without downloading image bytes.

Elicitation enforces a protocol-response gate, not proof that a human reviewed the prompt.
Use a host that presents the exact request to the user rather than automatically accepting it.
Approval is for a path and destination, not an immutable snapshot of the file before confirmation.
The existing no-final-symlink and inode checks remain in place, but parent symlinks and in-place file changes are not a trusted user-file picker.
If the client cannot confirm, ask the user to run `velvet upload-image KEY PATH --caption TEXT` or `velvet upload-image --milestone ID PATH --caption TEXT` manually for the exact intended file and target.
Never automatically fall back to the CLI or hosted transfer to bypass a refused or unsupported confirmation.
This gate protects only this local stdio MCP upload tool.
Native hosted upload preparation, terminal HTTP transfers, and the CLI remain governed by their own host approval policies, not this elicitation gate.
It does not establish a global consent guarantee for other tools available to an agent.

Attach important relevant user-provided images only to an explicit ticket or milestone, explaining their relevance in the caption.
Do not attach unrelated sensitive material or change status because an image was uploaded.
If no actual local file is available, ask for it and never claim an upload happened.

Hosted MCP cannot access files on the agent's computer.
Use hosted `velvet_prepare_image_upload` to obtain an upload endpoint and short-lived credential, then transfer the explicitly available local file using multipart HTTP with `X-Velvet-Upload-Token` and no cookies or Authorization header.
Alternatively, use this local tool or the CLI with the configured API token.
There is no browser upload page in this release.
Do not send local paths or image base64 as hosted image content.

## Configuration

The server requires these environment variables:

- `VELVET_URL`: the Velvet server URL without `/api/v1`, such as `https://worklog.example.com`.
- `VELVET_TOKEN`: a personal API token beginning with `velvet_`.

`VELVET_WORKSPACE` is optional.
When it is unset, the organisation and project are resolved from the checkout's Git remote, so one
configuration serves every repository instead of each needing its own hardcoded slug.

`VELVET_DEFAULT_STATUS` is optional and supplies the status for `velvet_create_ticket` when the tool caller does not provide one.
It must be one of `backlog`, `todo`, `in_progress`, `in_review`, `done`, or `cancelled`.

Keep `VELVET_TOKEN` in envkit and let envkit provide it to the child process.
Never put the token in a repository file, MCP configuration, or command-line example.

## Build and run locally

```bash
cd /Users/sabari/Developer/narayana/velvet-otter-lab/mcp
npm ci
npm run build
envkit run -- node /Users/sabari/Developer/narayana/velvet-otter-lab/mcp/dist/index.js
```

The process speaks MCP JSON-RPC on stdin and stdout.
Startup configuration failures are written to stderr and list every missing required variable.

## MCP client setup

The examples below use `envkit run --` as the configured command.
That keeps the token out of the client configuration.
Install the dependencies and build the server once, then use the same command in every project.

There is no per-project value to set.
When `VELVET_WORKSPACE` is unset, the server reads the checkout's Git remote once and asks
`POST /api/v1/me/resolve-repo` which organisation and project it belongs to, so one configuration
serves every repository.

Set `VELVET_WORKSPACE` only to override that, or in a directory whose repository is not connected
to any organisation. A remote that matches no connected repository, or matches two of your
organisations, is refused rather than guessed at: an agent writing into the wrong client's record
is worse than one that asks where it is.

Set the shared token before using any of the configurations:

```bash
envkit set VELVET_TOKEN
```

### jcode

Add this to the jcode MCP server configuration. The same block works in every project.

```json
{
  "mcpServers": {
    "velvet": {
      "command": "envkit",
      "args": [
        "run",
        "--",
        "node",
        "/Users/sabari/Developer/narayana/velvet-otter-lab/mcp/dist/index.js"
      ],
      "env": {
        "VELVET_URL": "https://worklog.example.com"
      }
    }
  }
}
```

Use `velvet_where_am_i` to confirm which organisation and project a checkout resolved to.

### Claude Code

Register the same stdio server with Claude Code from the project directory:

```bash
claude mcp add --transport stdio velvet -- \
  envkit run -- node /Users/sabari/Developer/narayana/velvet-otter-lab/mcp/dist/index.js
```

Set `VELVET_URL` in the project MCP settings. `VELVET_WORKSPACE` is optional.
The token remains in envkit and is not an argument to `claude` or `node`.

### `.mcp.json`

A project-local `.mcp.json` uses the same command and environment shape:

```json
{
  "mcpServers": {
    "velvet": {
      "type": "stdio",
      "command": "envkit",
      "args": [
        "run",
        "--",
        "node",
        "/Users/sabari/Developer/narayana/velvet-otter-lab/mcp/dist/index.js"
      ],
      "env": {
        "VELVET_URL": "https://worklog.example.com",
        "VELVET_WORKSPACE": "xi-ventures"
      }
    }
  }
}
```

Use `personal` in the personal project and `quantipeak` in the Quantipeak project.
Do not add `VELVET_TOKEN` to `.mcp.json`.

## Tools

- `velvet_log_work`: write a factual 1-3 sentence progress, decision, or blocker entry to a ticket.
- `velvet_current_ticket`: extract a case-insensitive issue key from the current Git branch and fetch that ticket.
- `velvet_create_ticket`: create a ticket and return its key and web URL.
- `velvet_get_ticket`: fetch a ticket and its approximately ten most recent comments.
- `velvet_list_issues`: list compact ticket key, title, status, and assignee information, optionally filtered by status or assignment.
- `velvet_set_status`: set a ticket status only after an explicit user request.
- `velvet_list_milestones`: list milestone IDs and names for filing new work under a goal.

Tool results are short, human-readable text rather than raw JSON.
Authentication failures say `token invalid or revoked`.
Missing issues say `no such issue in workspace <slug>`.
Network failures explain that the URL and connectivity should be checked.
