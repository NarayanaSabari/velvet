---
name: tickets
description: Find, read, create, edit, and assign Velvet tickets, manage comments and replies, and list evidence with the velvet CLI. Use when the user asks about tickets or issues, wants a ticket filed or edited, requests comments or evidence, or explicitly asks to move a ticket to a new status.
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

## Edit and assign

`velvet edit ENG-42 --title "Clear title" --desc "Expected result" --priority 2` changes only supplied fields.
Use `--assignee USER_UUID` or `--milestone MILESTONE_UUID` to assign or schedule an existing ticket.
Use `none` to clear either field, and `--desc ""` to clear the description.
Read the target first and change only what the user requested.
Labels and moving a ticket to another project are not supported.
Editing never changes status.

## Comments and evidence

`velvet comments ENG-42 list` reads the full thread, including replies and comment IDs.
Use `velvet comments --project list` for the linked project's thread.

```bash
velvet comments ENG-42 add --kind note "A user-requested note."
velvet comments ENG-42 add --parent COMMENT_UUID "A reply to that comment."
velvet comments ENG-42 edit COMMENT_UUID "Corrected text."
velvet comments ENG-42 delete COMMENT_UUID --yes
```

The same operations accept `--project` or `--milestone MILESTONE_UUID` in place of the ticket key.
`velvet comments --milestone MILESTONE_UUID list` reads a milestone's thread within the linked project.
Flags precede one quoted body argument. Add and edit also read the body from stdin.
Delete only with the user's explicit approval, then supply `--yes`.
Server permissions still decide whose comments can be edited or deleted.
`velvet evidence ENG-42 list` reads attached GitHub evidence.
Use `velvet attach ENG-42 REFERENCE` to attach a PR or commit, not to change status.

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
It cannot move tickets to another project. Assignees must be current members of the same organisation, subject to server permissions.
A viewer can read tickets but cannot change them; if a write fails for that reason, tell the user rather than retrying.
