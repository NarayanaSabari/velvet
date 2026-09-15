# Velvet MCP server

`velvet-mcp` is a private stdio MCP server that gives coding agents typed tools for the Velvet work-log API.
It uses the same `/api/v1` endpoints as [`cli/velvet`](../cli/velvet), without browser cookies or an `Origin` header.

## Configuration

The server requires these environment variables:

- `VELVET_URL`: the Velvet server URL without `/api/v1`, such as `https://worklog.example.com`.
- `VELVET_TOKEN`: a personal API token beginning with `velvet_`.
- `VELVET_WORKSPACE`: the workspace slug for the current project.

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
That keeps the token out of the client configuration while still allowing project-specific workspace routing.
Install the dependencies and build the server once, then use the same command in each project.

The only per-project value is `VELVET_WORKSPACE`:

| Project | `VELVET_WORKSPACE` |
| --- | --- |
| Personal | `personal` |
| XI Ventures | `xi-ventures` |
| Quantipeak | `quantipeak` |

Set the shared token before using any of the configurations:

```bash
envkit set VELVET_TOKEN
```

### jcode

Add this to the jcode MCP server configuration for the project.
Use the matching workspace value from the table above.

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
        "VELVET_URL": "https://worklog.example.com",
        "VELVET_WORKSPACE": "personal"
      }
    }
  }
}
```

For the XI Ventures project, change only `VELVET_WORKSPACE` to `xi-ventures`.
For the Quantipeak project, change only `VELVET_WORKSPACE` to `quantipeak`.

### Claude Code

Register the same stdio server with Claude Code from the project directory:

```bash
claude mcp add --transport stdio velvet -- \
  envkit run -- node /Users/sabari/Developer/narayana/velvet-otter-lab/mcp/dist/index.js
```

Set `VELVET_URL` and the project workspace in the project MCP settings.
Use `personal`, `xi-ventures`, or `quantipeak` for `VELVET_WORKSPACE` as appropriate.
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
