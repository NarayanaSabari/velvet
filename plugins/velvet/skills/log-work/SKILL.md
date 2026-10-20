---
name: log-work
description: Record a Velvet work-log entry. Use after finishing a meaningful unit of coding work such as a fix, feature, refactor, decision, or blocker, and whenever the user mentions their worklog, work log, Velvet, or asks to log, note, or record progress.
---

# Log work to Velvet

Velvet is the record of what work actually happened.
After each meaningful unit of work, write one entry with `velvet_log_work`.
Never skip logging because no ticket exists: there is always somewhere to put it.

## When to log

Log when something real changed:

- A fix, feature, or refactor landed (`progress`).
- A consequential implementation or scope choice was made (`decision`).
- Something is blocking, or a blocker just cleared (`blocker`).
- Anything else worth remembering later (`note`).

Do not log reading code, failed experiments that changed nothing, or every small edit.
One entry per meaningful unit is the right rhythm, usually a few per session.

## Choose where it goes

Work through these in order and stop at the first that applies:

1. **The branch names a ticket.**
   Run `git branch --show-current`, pass the result to `velvet_current_ticket`, and log with that ticket's `key`.
2. **The repository names a project.**
   Look for a "Velvet work log" section in `AGENTS.md` or `CLAUDE.md` and log with its `project` key.
3. **A project clearly matches the work.**
   Use `velvet_list_projects` and log with that `project` key.
4. **Nothing matches.**
   Ask the user once which project to use. Do not guess.

If the repository's Velvet section names a different organisation from the one `velvet_where_am_i` reports, tell the user instead of logging.
Never invent a ticket key, and never put an entry on an unrelated ticket.

## Write the entry

- One to three sentences, first person, factual.
- Say what changed, what was decided, or what is blocking, and why if it is not obvious.
- Name concrete things: the endpoint, the component, the failing test.
- Never invent time spent, estimates, or work that did not happen.

Good:

> I fixed the sprint board dropping cards when a PATCH failed. Failed moves now revert and say so in the toast.

Too vague:

> Worked on the board.

## Attach the proof

Once a pull request or commit exists, attach it with `velvet_attach_evidence` and the ticket key.
It accepts a pull request URL, `owner/repo#42`, or a commit sha.
Attaching evidence never changes a ticket's status.

## Never change status as a side effect

Do not call `velvet_set_status` because work was logged, a pull request merged, or evidence was attached.
Status changes only on the user's explicit request.
