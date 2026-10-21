---
name: tickets
description: Find, read, create, and update Velvet tickets with the velvet CLI. Use when the user asks about their tickets or issues, wants a ticket filed for a bug or task, or explicitly asks to move a ticket to a new status.
---

# Velvet tickets

Ticket keys look like `ENG-42`.
Every command works inside the repository's project, from `velvet.yaml`.

## Find and read

- `velvet issues`: this project's tickets. Add `--status in_progress` or `--mine`.
- `velvet issue ENG-42`: the ticket's status, priority, description, and recent work log.
- `velvet key-from-branch`: the ticket named by the current branch.

Read the ticket before working on it, so the change matches what was asked.

## Create

Run `velvet new "title"` when the user asks for a ticket, or when you find a real bug outside the current task that should not be lost.

- Short, specific title: what is wrong or what should exist.
- `--desc "..."`: steps to reproduce, or the outcome wanted, in a few lines.
- `--milestone ID` only when the user names one. `velvet milestones` lists them.
- `--priority N` from 0 (none) to 4, only when the user gives one.

New tickets always land in this repository's project.
Tell the user the new key.

## Status

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and `cancelled`.

Run `velvet status ENG-42 in_review` **only** when the user explicitly asks to move the ticket.
Never change a status because:

- you finished or logged work on it,
- a pull request was opened or merged,
- a branch was created or deleted,
- evidence or an image was attached.

The record should reflect what the person decided, not what tooling implied.
If you think a status is out of date, say so and ask.

## Limits

A repository's key reaches only its own project.
It cannot assign tickets to people or move them to another project; point the user to the Velvet web app for that.
A viewer can read tickets but cannot change them; if a write fails for that reason, tell the user rather than retrying.
