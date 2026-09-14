-- Fail before changing the identity contract or assigning installation owners.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_user WHERE email IS NULL OR btrim(email) = '') THEN
    RAISE EXCEPTION 'backfill app_user.email before applying 0006';
  END IF;
  IF EXISTS (SELECT 1 FROM membership WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'resolve unclaimed memberships before applying 0006';
  END IF;
  IF EXISTS (
    SELECT installation_id FROM repo GROUP BY installation_id
    HAVING count(DISTINCT workspace_id) > 1
  ) OR EXISTS (
    SELECT 1 FROM github_installation i JOIN repo r ON r.installation_id = i.id
    WHERE i.workspace_id IS NOT NULL AND i.workspace_id <> r.workspace_id
  ) THEN
    RAISE EXCEPTION 'resolve conflicting installation ownership before applying 0006';
  END IF;
  IF EXISTS (
    SELECT owner FROM (
      SELECT i.id, COALESCE(i.workspace_id, r.workspace_id) AS owner
      FROM github_installation i LEFT JOIN (SELECT DISTINCT installation_id, workspace_id FROM repo) r ON r.installation_id = i.id
    ) bindings WHERE owner IS NOT NULL GROUP BY owner HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'resolve multiple installation ownership before applying 0006';
  END IF;
END $$;

ALTER TABLE app_user ALTER COLUMN email SET NOT NULL;
ALTER TABLE membership ALTER COLUMN user_id SET NOT NULL;
DROP INDEX membership_workspace_login_idx;
ALTER TABLE membership DROP COLUMN invited_login;
DROP INDEX membership_user_idx;
ALTER TABLE membership ADD UNIQUE (workspace_id, user_id);
ALTER TABLE membership DROP CONSTRAINT membership_user_id_fkey;
ALTER TABLE membership ADD FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;

-- Invite/org deletion cannot erase rate-limit counters or turn an invite
-- login link into an ordinary sign-in link.
ALTER TABLE login_token DROP CONSTRAINT login_token_invite_fkey;
ALTER TABLE login_token ADD CONSTRAINT login_token_invite_fkey
  FOREIGN KEY (invite_id) REFERENCES invite(id) ON DELETE SET NULL;
CREATE FUNCTION invalidate_deleted_invite_tokens() RETURNS trigger AS $$
BEGIN
  UPDATE login_token SET consumed_at = COALESCE(consumed_at, now()) WHERE invite_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invalidate_deleted_invite_tokens BEFORE DELETE ON invite
  FOR EACH ROW EXECUTE FUNCTION invalidate_deleted_invite_tokens();

UPDATE github_installation i SET workspace_id = r.workspace_id
FROM (SELECT DISTINCT installation_id, workspace_id FROM repo) r
WHERE r.installation_id = i.id AND i.workspace_id IS NULL;
CREATE UNIQUE INDEX github_installation_workspace_idx ON github_installation (workspace_id) WHERE workspace_id IS NOT NULL;
ALTER TABLE github_installation
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN repos_synced_at timestamptz,
  ADD COLUMN ownership_verified_at timestamptz,
  ADD COLUMN sync_error text,
  ADD COLUMN sync_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE repo ADD COLUMN disconnected_at timestamptz;

-- Old setup tokens lack a session binding and cannot authorize the new flow.
UPDATE github_setup_state SET expires_at = LEAST(expires_at, now());
ALTER TABLE github_setup_state
  ADD COLUMN session_id text REFERENCES session(id) ON DELETE CASCADE,
  ADD COLUMN candidate_installation_id bigint,
  ADD COLUMN phase text NOT NULL DEFAULT 'installation' CHECK (phase IN ('installation', 'authorization', 'completed')),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN completed_at timestamptz;
-- Candidate ids deliberately have no installation FK: GitHub verification
-- must succeed before the installation row is created and bound.
CREATE TABLE github_authorization_state (
  token_hash text PRIMARY KEY,
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('link', 'installation')),
  setup_token_hash text REFERENCES github_setup_state(token_hash) ON DELETE CASCADE,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose = 'installation') = (setup_token_hash IS NOT NULL))
);
