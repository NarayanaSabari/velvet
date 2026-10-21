-- Keep CLI consent continuation on the email token, not in browser-local state.
ALTER TABLE login_token ADD COLUMN return_to text NOT NULL DEFAULT '';
