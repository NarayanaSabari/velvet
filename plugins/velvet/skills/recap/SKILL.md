---
name: recap
description: Summarise Velvet work logs, read project reports, and manage mentions with the velvet CLI. Use when the user asks for a standup, weekly summary, activity or milestone report, stale or closed work, or unread mentions.
---

# Recap from Velvet

`velvet recap` prints the user's work-log entries for this repository's project as Markdown.

- `--days N`: how far back. Default 7. Use 1 for a standup, 7 for a week, 30 for a month.

It covers only this project, because the repository's key reaches nothing else.
For a recap across every project, point the user to My work log in the Velvet web app.

## Reports and mentions

`velvet reports activity --from 2026-10-01 --to 2026-10-22` reads project activity for a date range.
`velvet reports milestones`, `velvet reports closed`, and `velvet reports stale --days 14` read other project reports.
Use only API results in summaries. Do not invent missing activity or imply account-wide coverage.

`velvet mentions` or `velvet mentions list --unread` reads mentions within this project.
`velvet mentions read COMMENT_ID...` marks selected mentions read when requested.
`velvet mentions read --all --yes` marks all mentions in this project read, only with explicit approval.
Reading a list does not authorize changing notification state.
These report and mention commands use the bound project key and reject server, account, or organisation overrides.
For organisation-wide views, use the management skill only after separately consented administration.

## Write the recap

Base it only on what the work log returns.
Do not add work you remember from this session unless it was logged, and never invent time spent.

Default shape, unless the user asks for another:

- Group by ticket, with project-level entries last.
- One line per ticket: the key, the title, and what changed in plain words.
- Call out blockers and decisions separately, because those are what readers act on.
- Keep it short enough to paste into a chat message.

For a standup, use three short parts: done, next, blocked.
"Next" can only come from the user or from open tickets in `velvet issues --mine`; say so if neither exists.

If the work log is empty for the period, say that plainly and suggest logging with the `log-work` skill.
