CREATE TABLE github_installation (
    id              bigint PRIMARY KEY,
    account_login   text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    suspended_at    timestamptz
);

CREATE TABLE repo (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    installation_id bigint NOT NULL REFERENCES github_installation(id) ON DELETE CASCADE,
    github_id       bigint NOT NULL UNIQUE,
    owner           text NOT NULL,
    name            text NOT NULL,
    default_branch  text NOT NULL DEFAULT 'main',
    synced_at       timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX repo_workspace_idx ON repo (workspace_id);

CREATE TYPE pr_state AS ENUM ('open', 'closed', 'merged');

CREATE TABLE pull_request (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    repo_id      uuid NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    number       integer NOT NULL,
    title        text NOT NULL,
    state        pr_state NOT NULL,
    draft        boolean NOT NULL DEFAULT false,
    author_login text NOT NULL DEFAULT '',
    author_id    uuid REFERENCES app_user(id) ON DELETE SET NULL,
    head_ref     text NOT NULL DEFAULT '',
    body         text NOT NULL DEFAULT '',
    additions    integer NOT NULL DEFAULT 0,
    deletions    integer NOT NULL DEFAULT 0,
    html_url     text NOT NULL DEFAULT '',
    merged_at    timestamptz,
    closed_at    timestamptz,
    gh_created_at timestamptz,
    gh_updated_at timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repo_id, number)
);
CREATE INDEX pull_request_workspace_idx ON pull_request (workspace_id, gh_updated_at DESC);

CREATE TYPE pr_link_source AS ENUM ('branch', 'body', 'manual');

CREATE TABLE pr_link (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    pull_request_id uuid NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
    issue_id        uuid NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    link_source     pr_link_source NOT NULL,
    closing         boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (pull_request_id, issue_id)
);
CREATE INDEX pr_link_issue_idx ON pr_link (issue_id);

CREATE TABLE pr_review (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    pull_request_id uuid NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
    github_id       bigint NOT NULL UNIQUE,
    reviewer_login  text NOT NULL,
    reviewer_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
    state           text NOT NULL,
    submitted_at    timestamptz NOT NULL
);
CREATE INDEX pr_review_pr_idx ON pr_review (pull_request_id, submitted_at);

CREATE TABLE commit_ref (
    sha          text PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    repo_id      uuid NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id     uuid REFERENCES issue(id) ON DELETE SET NULL,
    branch       text NOT NULL DEFAULT '',
    message      text NOT NULL DEFAULT '',
    author_login text NOT NULL DEFAULT '',
    html_url     text NOT NULL DEFAULT '',
    committed_at timestamptz NOT NULL
);
CREATE INDEX commit_ref_issue_idx ON commit_ref (issue_id, committed_at DESC)
    WHERE issue_id IS NOT NULL;

CREATE TABLE github_event (
    delivery_id  text PRIMARY KEY,
    event_type   text NOT NULL,
    payload      jsonb NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX github_event_unprocessed_idx ON github_event (received_at)
    WHERE processed_at IS NULL;

CREATE TABLE job (
    id          bigserial PRIMARY KEY,
    kind        text NOT NULL,
    payload     jsonb NOT NULL,
    run_after   timestamptz NOT NULL DEFAULT now(),
    attempts    integer NOT NULL DEFAULT 0,
    last_error  text,
    dead        boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_ready_idx ON job (run_after) WHERE NOT dead;
