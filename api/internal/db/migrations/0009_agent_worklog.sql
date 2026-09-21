-- Work-log entries an agent writes for itself.
--
-- Two problems are fixed here. First, comments could only hang off an issue or
-- a milestone, so an agent working on a branch that named no ticket had
-- nowhere to write and the guidance was to write nothing. Silently skipping
-- the log is the failure this product exists to prevent, so a project becomes
-- a comment target and work always has a home.
--
-- Second, a log entry could not say who or what wrote it. Attribution matters
-- when a person is asked to stand behind a record of their own work.
--
-- The new enum value is added but deliberately not used anywhere in this
-- file. Postgres refuses to use an enum value in the transaction that added
-- it, and the migration runner wraps each file in one transaction, so any
-- statement here referencing 'project' would fail the deploy.

ALTER TYPE comment_target ADD VALUE IF NOT EXISTS 'project';

-- Who wrote the entry. Derived from the authentication method rather than
-- supplied by the client, so a caller cannot claim to be something it is not.
ALTER TABLE comment ADD COLUMN source text NOT NULL DEFAULT 'human'
    CHECK (source IN ('human', 'agent'));

-- What kind of entry it is. Nullable because ordinary discussion is not a
-- classified work-log entry and must not be forced into one of these shapes.
ALTER TABLE comment ADD COLUMN kind text
    CHECK (kind IN ('progress', 'decision', 'blocker', 'note'));

-- Which agent token wrote it. ON DELETE SET NULL because revoking a token
-- must never delete the record of work that token wrote down.
ALTER TABLE comment ADD COLUMN api_token_id uuid
    REFERENCES api_token(id) ON DELETE SET NULL;

-- The recap reads every entry one person wrote across a time range. Without
-- this index that query degrades into a full scan of the whole comment table
-- exactly as the log becomes worth keeping.
CREATE INDEX comment_author_recent_idx
    ON comment (author_id, created_at DESC)
    WHERE deleted_at IS NULL;
