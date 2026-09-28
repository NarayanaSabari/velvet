-- Each project runs its own sprints.
--
-- A sprint was a calendar window for the whole organisation, so two projects
-- with different rhythms had to share one sprint and one active slot, and a
-- sprint board mixed every project's goals. A sprint now belongs to exactly
-- one project, and the one-active-sprint rule moves from the organisation to
-- the project, so each project can be mid-sprint independently.
--
-- A milestone already belongs to a sprint, so it belongs to that sprint's
-- project too, and a ticket filed under a milestone is work on that project.

ALTER TABLE sprint ADD COLUMN project_id uuid REFERENCES project(id) ON DELETE CASCADE;

-- Existing sprints need a project. An organisation with exactly one project
-- gets that project, which is the common case and the right answer. Any other
-- organisation that already has sprints gets one "General" project to hold
-- them, so nothing is lost and the sprints can be moved later.
UPDATE sprint s SET project_id = p.id
FROM project p
WHERE p.workspace_id = s.workspace_id
  AND s.project_id IS NULL
  AND (SELECT count(*) FROM project q WHERE q.workspace_id = s.workspace_id) = 1;

INSERT INTO project (workspace_id, key, name, description)
SELECT DISTINCT s.workspace_id,
       CASE WHEN EXISTS (SELECT 1 FROM project p WHERE p.workspace_id = s.workspace_id AND p.key = 'general')
            THEN 'general-sprints' ELSE 'general' END,
       'General',
       'Created to hold sprints that existed before sprints belonged to a project.'
FROM sprint s
WHERE s.project_id IS NULL;

UPDATE sprint s SET project_id = p.id
FROM project p
WHERE s.project_id IS NULL
  AND p.workspace_id = s.workspace_id
  AND p.key IN ('general', 'general-sprints')
  AND p.description = 'Created to hold sprints that existed before sprints belonged to a project.';

ALTER TABLE sprint ALTER COLUMN project_id SET NOT NULL;

-- One active sprint per project, not per organisation.
DROP INDEX sprint_single_active_idx;
CREATE UNIQUE INDEX sprint_single_active_idx ON sprint (project_id) WHERE state = 'active';
CREATE INDEX sprint_project_idx ON sprint (project_id, starts_on DESC);

-- A ticket in a milestone is work on that milestone's project. Align any
-- ticket whose project disagrees with its milestone, so the rule the API now
-- enforces also holds for data written before it.
UPDATE issue i SET project_id = s.project_id
FROM milestone m JOIN sprint s ON s.id = m.sprint_id
WHERE i.milestone_id = m.id
  AND i.project_id IS DISTINCT FROM s.project_id;
