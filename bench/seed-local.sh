#!/usr/bin/env bash
# Seeds the disposable e2e stack with a benchmark workspace: 1 workspace,
# 5 members, 3 projects, 6 labels, N issues (default 500) with labels and
# comments, plus a desktop API token. Prints the raw token.
# Usage: bench/seed-local.sh [issue-count]
# Destructive only for the e2e stack's own database (bench workspace rows).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
count="${1:-500}"
token="bench-$(date +%s)-$RANDOM"
hash=$(printf '%s' "$token" | shasum -a 256 | cut -d' ' -f1)

bash "$here/../e2e/stack-common.sh" exec -T postgres psql -U worklog -d worklog -q -v ON_ERROR_STOP=1 -v n="$count" -v hash="'$hash'" <<'SQL'
DELETE FROM workspace WHERE slug = 'bench';
DELETE FROM api_token WHERE name = 'bench-desktop';
INSERT INTO workspace (name, slug, issue_prefix, issue_counter)
VALUES ('Bench', 'bench', 'BEN', :n);

INSERT INTO app_user (email, github_id, github_login, name)
SELECT 'bench' || g || '@example.test', 9000 + g, 'bench' || g, 'Bench User ' || g
FROM generate_series(0, 4) g
ON CONFLICT (github_id) DO NOTHING;

INSERT INTO membership (workspace_id, user_id, role)
SELECT w.id, u.id, 'admin' FROM workspace w, app_user u
WHERE w.slug = 'bench' AND u.github_id BETWEEN 9000 AND 9004;

INSERT INTO api_token (user_id, name, token_hash, kind)
SELECT u.id, 'bench-desktop', :hash, 'desktop' FROM app_user u WHERE u.github_id = 9000;

INSERT INTO project (workspace_id, key, name)
SELECT w.id, k, k FROM workspace w, unnest(ARRAY['web','api','desktop']) k WHERE w.slug = 'bench';

INSERT INTO label (workspace_id, name)
SELECT w.id, k FROM workspace w, unnest(ARRAY['bug','feature','ux','infra','docs','release']) k WHERE w.slug = 'bench';

INSERT INTO issue (workspace_id, key, number, title, description, status, priority, assignee_id, project_id, position, created_by)
SELECT w.id, 'BEN-' || g, g,
  'Benchmark issue ' || g || ': ' || repeat('lorem ipsum ', 4),
  repeat('Paragraph of description text for issue ' || g || '. ', 12),
  (ARRAY['backlog','todo','in_progress','in_review','done','cancelled'])[1 + g % 6]::issue_status,
  g % 5,
  CASE WHEN g % 4 = 0 THEN NULL ELSE (SELECT id FROM app_user WHERE github_id = 9000 + g % 5) END,
  (SELECT id FROM project p WHERE p.workspace_id = w.id ORDER BY key OFFSET g % 3 LIMIT 1),
  lpad(g::text, 8, '0'),
  (SELECT id FROM app_user WHERE github_id = 9000)
FROM workspace w, generate_series(1, :n) g WHERE w.slug = 'bench';

INSERT INTO issue_label (issue_id, label_id)
SELECT i.id, l.id FROM issue i JOIN workspace w ON w.id = i.workspace_id
JOIN label l ON l.workspace_id = w.id
WHERE w.slug = 'bench' AND (i.number + length(l.name)) % 3 = 0;

INSERT INTO comment (workspace_id, target_type, target_id, author_id, body)
SELECT w.id, 'issue', i.id, (SELECT id FROM app_user WHERE github_id = 9000 + c % 5),
  'Progress update ' || c || ' on ' || i.key || '. ' || repeat('Detail. ', 10)
FROM issue i JOIN workspace w ON w.id = i.workspace_id, generate_series(1, 5) c
WHERE w.slug = 'bench';
SQL
echo "$token"
