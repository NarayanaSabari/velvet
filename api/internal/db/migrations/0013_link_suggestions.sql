-- Suggested issue links for work that arrived without a ticket.
--
-- A pull request whose branch names no issue, and an agent note logged against
-- a project, are both real work that a person later has to file by hand. Jev
-- reads the work and the organisation's open issues and suggests where it
-- belongs. A suggestion is only ever a suggestion: a person accepts or
-- dismisses it, and accepting never changes an issue's status.

-- On by default. An organisation can turn it off from Administration, and the
-- whole feature is inert until the server has a TypeSafe API key.
ALTER TABLE workspace ADD COLUMN jev_suggestions boolean NOT NULL DEFAULT true;

-- Accepted suggestions are recorded as their own link source, so the evidence
-- trail shows that a person confirmed a suggested link rather than typing it.
-- Not used in this file: Postgres refuses a new enum value inside the
-- transaction that added it.
ALTER TYPE pr_link_source ADD VALUE IF NOT EXISTS 'suggested';

CREATE TABLE link_suggestion (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    -- Exactly one subject. Deleting the work deletes its suggestion.
    pull_request_id uuid UNIQUE REFERENCES pull_request(id) ON DELETE CASCADE,
    comment_id      uuid UNIQUE REFERENCES comment(id) ON DELETE CASCADE,
    -- NULL means Jev was asked and no issue was a confident match. The row
    -- still exists so the same work is not sent again until it changes.
    issue_id        uuid REFERENCES issue(id) ON DELETE CASCADE,
    probability     real,
    model           text NOT NULL DEFAULT '',
    -- A hash of exactly what was asked. Unchanged work is never re-asked.
    fingerprint     text NOT NULL,
    dismissed_at    timestamptz,
    dismissed_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
    accepted_at     timestamptz,
    accepted_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT link_suggestion_one_subject
        CHECK ((pull_request_id IS NULL) <> (comment_id IS NULL)),
    CONSTRAINT link_suggestion_probability_range
        CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1))
);

-- The Unlinked work page reads open suggestions per organisation.
CREATE INDEX link_suggestion_open_idx
    ON link_suggestion (workspace_id, created_at DESC)
    WHERE issue_id IS NOT NULL AND dismissed_at IS NULL AND accepted_at IS NULL;
