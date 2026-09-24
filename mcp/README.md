# Velvet MCP server

> Most people should use the hosted server instead, which needs nothing installed: point an agent at `https://<velvet>/api/v1/w/<organisation>/mcp` with `Authorization: Bearer <token>`, or follow the setup at `/onboarding`.
> This local stdio server remains for resolving the organisation from a checkout's git remote.

`velvet-mcp` is a private stdio MCP server that gives coding agents typed tools for the Velvet work-log API.
It uses the same `/api/v1` endpoints as [`cli/velvet`](../cli/velvet), without browser cookies or an `Origin` header.

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
