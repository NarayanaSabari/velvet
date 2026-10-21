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
Do not activate it: activating a sprint completes whichever sprint the project had active, so only the user does that, from the sprint page.

## Create a milestone

```bash
velvet milestones new SPRINT_ID "Ship the billing rewrite"
```

The name states the goal.

## Schedule tickets

File a new ticket straight into a milestone with `velvet new "title" --milestone ID`.
Moving an existing ticket between milestones is done in the Velvet web app.
Scheduling a ticket never changes its status.

## The board

The sprint page in Velvet has a List | Board switch.
Point the user there when they want to see the sprint at a glance: `<velvet-url>/w/<organisation>/sprints/<sprint-id>?view=board`.
`velvet whoami` prints the organisation.
