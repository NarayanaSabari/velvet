-- Account management uses existing personal tokens, never setup credentials.
ALTER TABLE cli_session DROP CONSTRAINT cli_session_flow_check;
ALTER TABLE cli_session ADD CONSTRAINT cli_session_flow_check
    CHECK (flow IN ('init', 'login', 'manage'));
