-- Repository-scoped agent keys.
--
-- A key created by `velvet init` is bound to one organisation and one project,
-- and the server refuses everything outside them. The scope lives on the key,
-- not in the repository's velvet.yaml, so editing that file cannot widen what
-- an agent can reach.
--
-- A key with neither column set is a personal key, created by a person in the
-- browser. A scoped key always has both.
ALTER TABLE api_token
    ADD COLUMN workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
    ADD COLUMN project_id   uuid REFERENCES project(id) ON DELETE CASCADE,
    ADD CONSTRAINT api_token_scope_check CHECK ((workspace_id IS NULL) = (project_id IS NULL));

-- One pending `velvet init`. The CLI holds the device secret and polls with
-- it; the person approves in the browser by the short user code. Only the
-- secret's hash is stored. Approval records the chosen scope, and the key is
-- minted at the moment the CLI collects it, so no raw key is ever stored.
CREATE TABLE cli_session (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_hash      text NOT NULL UNIQUE,
    user_code        text NOT NULL UNIQUE,
    client_name      text NOT NULL,
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'denied', 'collected')),
    approved_by      uuid REFERENCES app_user(id) ON DELETE CASCADE,
    workspace_id     uuid REFERENCES workspace(id) ON DELETE CASCADE,
    project_id       uuid REFERENCES project(id) ON DELETE CASCADE,
    api_token_id     uuid REFERENCES api_token(id) ON DELETE CASCADE,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL
);

CREATE INDEX cli_session_expires_idx ON cli_session (expires_at);
