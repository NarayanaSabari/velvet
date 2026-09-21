-- A project is the durable unit of work inside an organisation. A milestone
-- dies with its sprint, so it cannot represent something worked on for months
-- across several sprints. Projects deliberately have no sprint reference: a
-- sprint is a calendar window, a project is the thing the work is about.

CREATE TYPE project_status AS ENUM ('active', 'archived');

CREATE TABLE project (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    key          text NOT NULL,
    name         text NOT NULL,
    description  text NOT NULL DEFAULT '',
    status       project_status NOT NULL DEFAULT 'active',
    created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    archived_at  timestamptz,
    CONSTRAINT project_key_shape CHECK (key ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
    CONSTRAINT project_archived_consistent
        CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

-- The key is how an agent names a project from a shell without knowing a UUID,
-- so it must be unique per workspace and stable.
CREATE UNIQUE INDEX project_workspace_key_idx ON project (workspace_id, key);
CREATE INDEX project_workspace_status_idx ON project (workspace_id, status, name);

-- Nullable on purpose. Work arrives before anyone has filed it under a
-- project, and requiring one at creation makes people skip logging entirely,
-- which is the same reasoning that keeps the unfiled issue backlog.
ALTER TABLE issue ADD COLUMN project_id uuid REFERENCES project(id) ON DELETE SET NULL;
CREATE INDEX issue_project_idx ON issue (workspace_id, project_id, position)
    WHERE project_id IS NOT NULL;

-- A repository maps to at most one project, which is what lets a commit on a
-- branch carrying no issue key still be attributed to the work it belongs to.
ALTER TABLE repo ADD COLUMN project_id uuid REFERENCES project(id) ON DELETE SET NULL;
CREATE INDEX repo_project_idx ON repo (project_id) WHERE project_id IS NOT NULL;
