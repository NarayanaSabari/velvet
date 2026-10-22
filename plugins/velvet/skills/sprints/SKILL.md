---
name: sprints
description: Plan Velvet sprints and milestones with the velvet CLI. Use when the user asks to create or list sprints or milestones, plan work into a sprint, or schedule tickets into a milestone, including when they ask to work in a sprint that does not exist yet.
---

# Velvet sprints and milestones

Each project runs its own sprints.
A sprint is a calendar window, a milestone inside it names a goal, and tickets sit in milestones.
Every command works inside the repository's project, from `velvet.yaml`.

## Look before creating

- `velvet sprints`: this project's sprints, with their ids and status.
- `velvet milestones`: milestones in this project. `velvet milestones SPRINT_ID` limits to one sprint.

## Create a sprint

When the user asks to work in a sprint that does not exist yet, create it rather than treating it as a dead end:

```bash
velvet sprints new "November 2026" 2026-11-01 2026-11-30
```

Confirm the dates with the user if they did not give them.
A new sprint starts `upcoming`.
Do not activate it autonomously. `velvet sprint SPRINT_ID activate --yes` completes the project's previous active sprint.
Use it only when the user explicitly requests that transition.
`velvet sprint SPRINT_ID complete --yes` closes the sprint, also only when requested.

## Create a milestone

```bash
velvet milestones new SPRINT_ID "Ship the billing rewrite"
```

The name states the goal.

## Schedule tickets

File a new ticket straight into a milestone with `velvet new "title" --milestone ID`.
Moving an existing ticket into a milestone uses `velvet edit ENG-42 --milestone MILESTONE_UUID`.
Clear that schedule with `--milestone none`.
Scheduling a ticket never changes its status.

## Inspect and edit planning

`velvet sprint SPRINT_ID show` and `velvet milestone MILESTONE_ID show` read full details.
Change only the fields the user requested:

```bash
velvet sprint SPRINT_ID edit --name "Release window" --starts-on 2026-11-01 --ends-on 2026-11-30
velvet milestone MILESTONE_ID edit --name "Ship billing" --description "Accepted result" --target-date 2026-11-20
```

`velvet sprints edit SPRINT_ID` and `velvet milestones edit MILESTONE_ID` are aliases for these edit forms.
Milestone `--target-date ""` clears the date.
Milestone `--after ID` and `--before ID` reorder relative to sibling milestones, not move between sprints.
Milestone `--status` accepts `planned`, `in_progress`, `completed`, or `cancelled`.
Completing or cancelling a milestone also requires `--yes`.
Never infer a sprint, milestone, or ticket status change from code, evidence, or a deployment.
Sprint deletion and milestone reassignment to another sprint are not supported by these commands.

## The board

The sprint page in Velvet has a List | Board switch.
Point the user there when they want to see the sprint at a glance: `<velvet-url>/w/<organisation>/sprints/<sprint-id>?view=board`.
`velvet whoami` prints the organisation.
