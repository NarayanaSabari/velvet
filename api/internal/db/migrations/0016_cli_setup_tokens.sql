-- Machine setup credentials are distinct from unrestricted personal tokens.
-- Apply with the kind-aware API binary. Older binaries cannot mint scoped
-- tokens after this migration because they omit kind on insert.
ALTER TABLE api_token ADD COLUMN kind text NOT NULL DEFAULT 'personal';
UPDATE api_token SET kind = 'project' WHERE project_id IS NOT NULL;
ALTER TABLE api_token
    ADD COLUMN parent_id uuid REFERENCES api_token(id) ON DELETE CASCADE,
    ADD CONSTRAINT api_token_kind_check CHECK (
        (kind IN ('personal', 'setup') AND project_id IS NULL AND parent_id IS NULL)
        OR (kind = 'project' AND project_id IS NOT NULL)
    );
CREATE UNIQUE INDEX api_token_parent_project_idx ON api_token(parent_id, project_id) WHERE parent_id IS NOT NULL;
ALTER TABLE cli_session ADD COLUMN flow text NOT NULL DEFAULT 'init' CHECK (flow IN ('init', 'login'));
