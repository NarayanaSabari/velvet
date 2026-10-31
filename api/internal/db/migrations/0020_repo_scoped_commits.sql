-- A commit can appear in multiple repositories, including forks in different
-- workspaces. Preserve each repository's evidence independently.
ALTER TABLE commit_ref DROP CONSTRAINT commit_ref_pkey;
ALTER TABLE commit_ref ADD PRIMARY KEY (repo_id, sha);
