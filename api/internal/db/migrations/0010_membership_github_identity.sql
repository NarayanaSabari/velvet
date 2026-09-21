-- Per-organisation GitHub identity.
--
-- app_user holds exactly one github_login, and PR authorship is resolved by
-- matching that single login against membership. Someone who uses a different
-- GitHub account for each client organisation therefore gets their work
-- attributed in at most one organisation, and every other organisation shows
-- their pull requests as authored by nobody.
--
-- The work is the thing this product records, so failing to recognise whose
-- work it is defeats the point.

CREATE TABLE membership_github_identity (
    membership_id uuid PRIMARY KEY REFERENCES membership(id) ON DELETE CASCADE,
    workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    github_id     bigint NOT NULL,
    github_login  text NOT NULL,
    linked_at     timestamptz NOT NULL DEFAULT now()
);

-- One GitHub account cannot be claimed by two people inside one organisation,
-- or attribution there would be ambiguous. The same account may still appear
-- in another organisation, which is what makes per-org identity possible.
CREATE UNIQUE INDEX membership_github_identity_account_idx
    ON membership_github_identity (workspace_id, github_id);
CREATE INDEX membership_github_identity_login_idx
    ON membership_github_identity (workspace_id, lower(github_login));
CREATE INDEX membership_github_identity_user_idx
    ON membership_github_identity (user_id);

-- Backfill from the existing global identity so attribution that works today
-- keeps working after this migration, before anyone links a second account.
INSERT INTO membership_github_identity (membership_id, workspace_id, user_id, github_id, github_login)
SELECT m.id, m.workspace_id, m.user_id, u.github_id, u.github_login
FROM membership m
JOIN app_user u ON u.id = m.user_id
WHERE u.github_id IS NOT NULL AND u.github_login IS NOT NULL
ON CONFLICT DO NOTHING;

-- A link authorization may now name the organisation it was started from, so
-- completing it records which account this person uses there. Nullable keeps
-- the existing profile-only link working unchanged.
ALTER TABLE github_authorization_state
  ADD COLUMN link_workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  ADD CONSTRAINT github_authorization_link_workspace
    CHECK (link_workspace_id IS NULL OR purpose = 'link');

