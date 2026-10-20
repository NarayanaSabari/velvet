---
name: sprints
description: Plan Velvet sprints and milestones. Use when the user asks to create or list sprints or milestones, plan work into a sprint, or schedule tickets into a milestone, including when they ask to work in a sprint that does not exist yet.
---

# Velvet sprints and milestones

Each project runs its own sprints.
A sprint is a calendar window; a milestone inside it names a goal; tickets sit in milestones.

## Look before creating

- `velvet_list_projects`: projects and their keys.
- `velvet_list_sprints`: sprints, optionally for one `project`.
- `velvet_list_milestones`: milestones with their sprint and status.

## Create a sprint

When the user asks to work in a sprint that does not exist yet, create it rather than treating it as a dead end.

`velvet_create_sprint` takes the `project` key, a `name` such as `November 2026`, and `starts_on` and `ends_on` as `YYYY-MM-DD`.
Confirm the dates with the user if they did not give them.

A new sprint starts `upcoming`.
Do not activate it: activating a sprint completes whichever sprint the project had active, so only the user does that, from the sprint page.

## Create a milestone

`velvet_create_milestone` takes a `sprint_id` from `velvet_list_sprints` and a `name` that states the goal, such as `Ship the billing rewrite`.
Add a description or target date only when the user gives one.

## Schedule tickets

- New ticket: `velvet_create_ticket` with `milestone_id`.
- Existing ticket: `velvet_update_ticket` with `milestone_id`, or an empty string to unschedule.

Moving a ticket into a milestone does not change its status.

## The board

The sprint page in Velvet has a List | Board switch.
The board shows Backlog, Todo, In progress, In review, and Done columns.
Point the user there when they want to see the sprint at a glance: `<velvet-url>/w/<organisation>/sprints/<sprint-id>?view=board`.
