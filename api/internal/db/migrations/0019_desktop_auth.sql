-- Desktop consent grants normal app access through current membership roles.
-- Roll back the API first only after revoking desktop tokens and expiring
-- desktop sessions. Older APIs do not recognize this flow in collection.
ALTER TABLE api_token DROP CONSTRAINT api_token_kind_check;
ALTER TABLE api_token ADD CONSTRAINT api_token_kind_check CHECK (
    (kind IN ('personal', 'setup', 'desktop') AND project_id IS NULL AND parent_id IS NULL)
    OR (kind = 'project' AND project_id IS NOT NULL)
);
ALTER TABLE cli_session DROP CONSTRAINT cli_session_flow_check;
ALTER TABLE cli_session ADD CONSTRAINT cli_session_flow_check
    CHECK (flow IN ('init', 'login', 'manage', 'desktop'));
