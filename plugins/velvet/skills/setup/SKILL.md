---
name: setup
description: Connect this agent to Velvet. Use when the user installs the Velvet plugin, asks to connect or set up Velvet, or when Velvet tools such as velvet_log_work are missing or fail with an invalid-token error.
---

# Connect to Velvet

Velvet hosts an MCP server per organisation at `<velvet-url>/api/v1/w/<organisation>/mcp`.
It accepts a personal API token as a bearer token and nothing else.

## 1. Check whether it already works

Call `velvet_where_am_i`.
If it answers with an organisation and role, setup is done: tell the user which organisation and role it reported, and stop.

## 2. Collect the three values

Ask only for what is missing:

- **Velvet URL**: for example `https://velvet.sabarinarayana.com`, with no trailing slash and no `/api/v1`.
- **Organisation slug**: the part after `/w/` in the Velvet address bar, such as `lab`.
- **API token**: created in Velvet under Profile > Agent config. It starts with `velvet_` and is shown once.

Never ask the user to paste the token into chat, never echo it, and never write it into a repository file, `AGENTS.md`, `CLAUDE.md`, or shell history.
Tell the user to keep it in their secret manager or an environment variable.

## 3. Wire it up for this agent

**Claude Code.**
The plugin prompts for the URL, organisation, and token when it is enabled, and stores the token in the system keychain.
If the values are wrong, tell the user to run `/plugin`, open Velvet, and update its configuration, then `/reload-plugins`.

**Codex.**
Ask the user to export the token in their shell profile or secret manager as `VELVET_TOKEN`, then register the server so Codex reads the token from that variable:

```bash
codex mcp add velvet --url "<velvet-url>/api/v1/w/<organisation>/mcp" --bearer-token-env-var VELVET_TOKEN
```

Restart Codex so it connects.

**Any other agent.**
Point a remote HTTP MCP client at the same URL with the header `Authorization: Bearer <token>`.
Velvet does not support stdio-only clients.

## 4. Verify

Call `velvet_where_am_i` again and report the organisation, issue prefix, and role.
A `token invalid or revoked` error means the token is wrong or was revoked: ask for a fresh one from Profile > Agent config.
A viewer role can read but not write, so say that logging work will not be possible.

## 5. Point the repository at a project (optional)

If the user wants this repository's work to land in one project, add a short section to `AGENTS.md` or `CLAUDE.md`.
Velvet's Agent config page generates it; it contains no token and is safe to commit:

```markdown
## Velvet work log

This repository logs work to the Velvet project `<project-key>` in the `<organisation>` organisation, through the `velvet` MCP server.
```

Run `velvet_list_projects` to find the key.
