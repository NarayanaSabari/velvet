-- Email becomes the identity; GitHub becomes an optional link on the user.
ALTER TABLE app_user ADD COLUMN email text;
CREATE UNIQUE INDEX app_user_email_idx ON app_user (lower(email));
ALTER TABLE app_user ALTER COLUMN github_id DROP NOT NULL;
ALTER TABLE app_user ALTER COLUMN github_login DROP NOT NULL;

-- Sign-in links. Only the hash is stored, like sessions.
CREATE TABLE login_token (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  text NOT NULL UNIQUE,
    email       text NOT NULL,
    invite_id   uuid,
    request_ip  text NOT NULL DEFAULT '',
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_token_email_created_idx ON login_token (lower(email), created_at);
CREATE INDEX login_token_ip_created_idx ON login_token (request_ip, created_at);

CREATE TABLE invite (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    email        text NOT NULL,
    role         membership_role NOT NULL DEFAULT 'member',
    token_hash   text NOT NULL UNIQUE,
    invited_by   uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    expires_at   timestamptz NOT NULL,
    accepted_at  timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
-- One live invite per address per organisation; re-inviting replaces it.
CREATE UNIQUE INDEX invite_pending_idx ON invite (workspace_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE login_token ADD CONSTRAINT login_token_invite_fkey
    FOREIGN KEY (invite_id) REFERENCES invite(id) ON DELETE CASCADE;

-- An installation belongs to at most one organisation.
ALTER TABLE github_installation
    ADD COLUMN workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL;

-- One-time state carried through the App installation page.
CREATE TABLE github_setup_state (
    token_hash   text PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    expires_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE session ADD COLUMN last_workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL;
