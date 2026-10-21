---
name: recap
description: Summarise what the user worked on from their Velvet work log with velvet recap. Use when the user asks what they have been working on, wants a standup update, weekly summary, status report, or recap for a period.
---

# Recap from Velvet

`velvet recap` prints the user's work-log entries for this repository's project as Markdown.

- `--days N`: how far back. Default 7. Use 1 for a standup, 7 for a week, 30 for a month.

It covers only this project, because the repository's key reaches nothing else.
For a recap across every project, point the user to My work log in the Velvet web app.

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
