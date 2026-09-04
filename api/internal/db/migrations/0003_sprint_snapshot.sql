-- A sprint's report is frozen at close, so a later edit to an issue cannot
-- silently rewrite last month's numbers. The counts are stored as jsonb
-- rather than columns because the interesting shape is "count per status" and
-- "total per person", both of which would otherwise need a table each to say
-- something no query will ever join against.
CREATE TABLE sprint_snapshot (
    sprint_id            uuid PRIMARY KEY REFERENCES sprint(id) ON DELETE CASCADE,
    workspace_id         uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    milestones_planned   integer NOT NULL,
    milestones_completed integer NOT NULL,
    issue_counts         jsonb NOT NULL,
    person_totals        jsonb NOT NULL,
    captured_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sprint_snapshot_workspace_idx ON sprint_snapshot (workspace_id);
