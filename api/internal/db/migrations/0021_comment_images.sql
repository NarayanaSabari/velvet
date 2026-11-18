-- An image can belong to one comment on the same issue or milestone. The web
-- shows it inside that comment instead of the Images section. Comments are
-- soft-deleted, so the images of a deleted comment stay stored but hidden.
ALTER TABLE image_attachment ADD COLUMN comment_id uuid REFERENCES comment(id) ON DELETE CASCADE;
CREATE INDEX image_comment_idx ON image_attachment(comment_id) WHERE comment_id IS NOT NULL;

-- Retrying an upload stays idempotent per comment, so the same screenshot can
-- prove two different comments.
DROP INDEX image_issue_retry_idx;
DROP INDEX image_milestone_retry_idx;
CREATE UNIQUE INDEX image_issue_retry_idx ON image_attachment(workspace_id, issue_id, uploader_id, digest, (digest(caption, 'sha256')), (COALESCE(comment_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE issue_id IS NOT NULL;
CREATE UNIQUE INDEX image_milestone_retry_idx ON image_attachment(workspace_id, milestone_id, uploader_id, digest, (digest(caption, 'sha256')), (COALESCE(comment_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE milestone_id IS NOT NULL;
