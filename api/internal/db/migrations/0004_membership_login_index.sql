-- Earlier versions treated GitHub logins as case-sensitive invites even
-- though GitHub and the OAuth binding do not. Keep a bound row first, then
-- the most privileged invite, when cleaning up any pre-existing duplicates.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY workspace_id, lower(invited_login)
               ORDER BY (user_id IS NOT NULL) DESC,
                        CASE role
                            WHEN 'admin' THEN 1
                            WHEN 'member' THEN 2
                            ELSE 3
                        END,
                        created_at,
                        id
           ) AS position
    FROM membership
)
DELETE FROM membership m
USING ranked r
WHERE m.id = r.id AND r.position > 1;

ALTER TABLE membership
    DROP CONSTRAINT membership_workspace_id_invited_login_key;

UPDATE membership SET invited_login = lower(invited_login);

CREATE UNIQUE INDEX membership_workspace_login_idx
    ON membership (workspace_id, lower(invited_login));
