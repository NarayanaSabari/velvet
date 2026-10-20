---
name: tickets
description: Find, read, create, and update Velvet tickets. Use when the user asks about their tickets or issues, wants a ticket filed for a bug or task, wants a ticket's title, description, priority, project, or milestone changed, or explicitly asks to move a ticket to a new status.
---

# Velvet tickets

Ticket keys look like `ENG-42`.
`velvet_where_am_i` reports the organisation's prefix.

## Find and read

- `velvet_list_issues`: filter by `status`, `mine: true`, or `project`.
- `velvet_get_ticket`: the ticket's status, priority, assignee, milestone, description, and about ten most recent work-log entries.
- `velvet_current_ticket`: the ticket named by the current branch. Pass `git branch --show-current`.

Read the ticket before working on it, so the change matches what was asked.

## Create

Use `velvet_create_ticket` when the user asks for a ticket, or when you find a real bug outside the current task that should not be lost.

- Short, specific title: what is wrong or what should exist.
- Description: steps to reproduce, or the outcome wanted, in a few lines.
- File it under the repository's project when one is known (see the `log-work` skill for how to find it).
- Put it in a milestone only when the user names one. `velvet_list_milestones` lists them.
- Priority runs from 0 (none) to 4. Leave it unset unless the user gives one.

Tell the user the new key.

## Update

`velvet_update_ticket` changes title, description, priority, project, or milestone.
Pass an empty string for `project` or `milestone_id` to clear it.
Only change the fields the user asked about.

## Status

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and `cancelled`.

Call `velvet_set_status` **only** when the user explicitly asks to move the ticket.
Never change a status because:

- you finished or logged work on it,
- a pull request was opened or merged,
- a branch was created or deleted,
- evidence or an image was attached.

The record should reflect what the person decided, not what tooling implied.
If you think a status is out of date, say so and ask.

## Viewers

A viewer can read tickets but cannot change them.
If a write fails for that reason, tell the user rather than retrying.
