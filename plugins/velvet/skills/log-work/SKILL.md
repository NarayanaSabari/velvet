---
name: log-work
description: Record a Velvet work-log entry with the velvet CLI. Use after finishing a meaningful unit of coding work such as a fix, feature, refactor, decision, or blocker, and whenever the user mentions their worklog, work log, Velvet, or asks to log, note, or record progress.
---

# Log work to Velvet

Velvet is the record of what work actually happened.
After each meaningful unit of work, write one entry with `velvet log`.
Never skip logging because no ticket exists: there is always somewhere to put it.

## When to log

Log when something real changed:

- A fix, feature, or refactor landed (`progress`, the default).
- A consequential implementation or scope choice was made (`--kind decision`).
- Something is blocking, or a blocker just cleared (`--kind blocker`).
- Anything else worth remembering later (`--kind note`).

Do not log reading code, failed experiments that changed nothing, or every small edit.
One entry per meaningful unit is the right rhythm, usually a few per session.

## Choose where it goes

1. **The branch names a ticket.**
   `velvet key-from-branch` prints its key, such as `ENG-42`. Log with that key: `velvet log ENG-42 "..."`.
2. **Otherwise, log to the project.**
   `velvet log "..."` with no key lands on the repository's project, from `velvet.yaml`.

Never invent a ticket key, and never put an entry on an unrelated ticket.
If a command fails with exit code 7, the ticket belongs to another project: tell the user rather than looking for a way around it.

## Write the entry

- One to three sentences, first person, factual.
- Say what changed, what was decided, or what is blocking, and why if it is not obvious.
- Name concrete things: the endpoint, the component, the failing test.
- Never invent time spent, estimates, or work that did not happen.
- Flags go before the message: `velvet log ENG-42 --kind decision "..."`.
- For a long entry, pipe it in: `printf '%s\n' "..." | velvet log ENG-42`.

Good:

> I fixed the sprint board dropping cards when a PATCH failed. Failed moves now revert and say so in the toast.

Too vague:

> Worked on the board.

## Attach the proof

Once a pull request or commit exists, attach it: `velvet attach ENG-42 https://github.com/acme/web/pull/7`.
It accepts a pull request URL, `owner/repo#42`, or a commit sha.
Attaching evidence never changes a ticket's status.

## Never change status as a side effect

Do not run `velvet status` because work was logged, a pull request merged, or evidence was attached.
Status changes only on the user's explicit request.
