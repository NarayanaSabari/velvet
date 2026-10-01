-- Bytes live in Postgres so the ordinary database backup includes attachments.
ALTER TABLE issue ADD CONSTRAINT issue_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE milestone ADD CONSTRAINT milestone_workspace_id_unique UNIQUE (workspace_id, id);

CREATE TABLE image_attachment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    issue_id uuid,
    milestone_id uuid,
    uploader_id uuid NOT NULL REFERENCES app_user(id),
    api_token_id uuid REFERENCES api_token(id) ON DELETE SET NULL,
    source text NOT NULL CHECK (source IN ('human', 'agent')),
    filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
    caption text NOT NULL CHECK (length(btrim(caption)) BETWEEN 1 AND 2000),
    content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
    byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
    width integer NOT NULL CHECK (width > 0),
    height integer NOT NULL CHECK (height > 0 AND width::bigint * height <= 20000000),
    data bytea NOT NULL CHECK (octet_length(data) = byte_size),
    digest text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(issue_id, milestone_id) = 1),
    FOREIGN KEY (workspace_id, issue_id) REFERENCES issue(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, milestone_id) REFERENCES milestone(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX image_issue_retry_idx ON image_attachment(workspace_id, issue_id, uploader_id, digest, (digest(caption, 'sha256'))) WHERE issue_id IS NOT NULL;
CREATE UNIQUE INDEX image_milestone_retry_idx ON image_attachment(workspace_id, milestone_id, uploader_id, digest, (digest(caption, 'sha256'))) WHERE milestone_id IS NOT NULL;
CREATE INDEX image_workspace_idx ON image_attachment(workspace_id, created_at, id);

CREATE TABLE image_upload_grant (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    issue_id uuid,
    milestone_id uuid,
    uploader_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    api_token_id uuid NOT NULL REFERENCES api_token(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
    caption text NOT NULL CHECK (length(btrim(caption)) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
    CHECK (num_nonnulls(issue_id, milestone_id) = 1),
    FOREIGN KEY (workspace_id, issue_id) REFERENCES issue(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, milestone_id) REFERENCES milestone(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX image_upload_expiry_idx ON image_upload_grant(expires_at);
CREATE INDEX image_upload_workspace_idx ON image_upload_grant(workspace_id, uploader_id);
