---
name: recap
description: Summarise what the user worked on from their Velvet work log. Use when the user asks what they have been working on, wants a standup update, weekly summary, status report, or recap for a period, organisation, or project.
---

# Recap from Velvet

`velvet_my_worklog` returns the user's entries across every organisation they belong to.

- `days`: how far back. Default 7. Use 1 for a standup, 7 for a week, 30 for a month.
- `workspace`: limit to one organisation slug.
- `project`: limit to one project key.

## Write the recap

Base it only on what the work log returns.
Do not add work you remember from this session unless it was logged, and never invent time spent.

Default shape, unless the user asks for another:

- Group by project, then by ticket.
- One line per ticket: the key, the title, and what changed in plain words.
- Call out blockers and decisions separately, because those are what readers act on.
- Keep it short enough to paste into a chat message.

For a standup, use three short parts: done, next, blocked.
"Next" can only come from the user or from open tickets in `velvet_list_issues` with `mine: true`; say so if neither exists.

If the work log is empty for the period, say that plainly and suggest logging with the `log-work` skill.
