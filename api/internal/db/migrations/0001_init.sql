CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_user (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    github_id   bigint NOT NULL UNIQUE,
    github_login text NOT NULL,
    name        text NOT NULL DEFAULT '',
    avatar_url  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_user_login_idx ON app_user (lower(github_login));

CREATE TABLE workspace (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    slug          text NOT NULL UNIQUE,
    issue_prefix  text NOT NULL DEFAULT 'ENG',
    issue_counter bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE membership_role AS ENUM ('admin', 'member', 'viewer');

CREATE TABLE membership (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
    invited_login text NOT NULL,
    role          membership_role NOT NULL DEFAULT 'member',
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, invited_login)
);
CREATE UNIQUE INDEX membership_user_idx
    ON membership (workspace_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE session (
    id         text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX session_user_idx ON session (user_id);

CREATE TYPE sprint_state AS ENUM ('upcoming', 'active', 'completed');

CREATE TABLE sprint (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name         text NOT NULL,
    starts_on    date NOT NULL,
    ends_on      date NOT NULL,
    state        sprint_state NOT NULL DEFAULT 'upcoming',
    created_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT sprint_dates_ordered CHECK (ends_on >= starts_on)
);
CREATE INDEX sprint_workspace_idx ON sprint (workspace_id, starts_on DESC);
CREATE UNIQUE INDEX sprint_single_active_idx
    ON sprint (workspace_id) WHERE state = 'active';

CREATE TYPE milestone_status AS ENUM ('planned', 'in_progress', 'completed', 'cancelled');

CREATE TABLE milestone (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    sprint_id    uuid NOT NULL REFERENCES sprint(id) ON DELETE CASCADE,
    name         text NOT NULL,
    description  text NOT NULL DEFAULT '',
    owner_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
    target_date  date,
    status       milestone_status NOT NULL DEFAULT 'planned',
    position     text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX milestone_sprint_idx ON milestone (workspace_id, sprint_id, position);

CREATE TYPE issue_status AS ENUM
    ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled');

CREATE TABLE issue (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    key          text NOT NULL,
    number       bigint NOT NULL,
    title        text NOT NULL,
    description  text NOT NULL DEFAULT '',
    status       issue_status NOT NULL DEFAULT 'backlog',
    priority     smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
    assignee_id  uuid REFERENCES app_user(id) ON DELETE SET NULL,
    milestone_id uuid REFERENCES milestone(id) ON DELETE SET NULL,
    parent_id    uuid REFERENCES issue(id) ON DELETE SET NULL,
    position     text NOT NULL,
    created_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, key)
);
CREATE INDEX issue_milestone_idx ON issue (workspace_id, milestone_id, position);
CREATE INDEX issue_assignee_idx ON issue (workspace_id, assignee_id, status);
CREATE INDEX issue_parent_idx ON issue (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX issue_status_updated_idx ON issue (workspace_id, status, updated_at DESC);

-- Sub-issues are one level deep. Enforced here so no code path can violate it.
CREATE FUNCTION issue_depth_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL THEN
        IF NEW.parent_id = NEW.id THEN
            RAISE EXCEPTION 'issue cannot be its own parent';
        END IF;
        IF EXISTS (SELECT 1 FROM issue WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN
            RAISE EXCEPTION 'sub-issues may not be nested more than one level';
        END IF;
        IF EXISTS (SELECT 1 FROM issue WHERE parent_id = NEW.id) THEN
            RAISE EXCEPTION 'an issue with children cannot become a sub-issue';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issue_depth_guard_trigger
    BEFORE INSERT OR UPDATE OF parent_id ON issue
    FOR EACH ROW EXECUTE FUNCTION issue_depth_guard();

CREATE TABLE label (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name         text NOT NULL,
    color        text NOT NULL DEFAULT '#111111',
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);

CREATE TABLE issue_label (
    issue_id uuid NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    label_id uuid NOT NULL REFERENCES label(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX issue_label_label_idx ON issue_label (label_id);

CREATE TYPE comment_target AS ENUM ('issue', 'milestone');

CREATE TABLE comment (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    target_type  comment_target NOT NULL,
    target_id    uuid NOT NULL,
    parent_id    uuid REFERENCES comment(id) ON DELETE CASCADE,
    author_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    body         text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    edited_at    timestamptz,
    deleted_at   timestamptz
);
CREATE INDEX comment_target_idx
    ON comment (workspace_id, target_type, target_id, created_at);

-- Comment threading is one level deep, same reasoning as sub-issues.
CREATE FUNCTION comment_depth_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM comment WHERE id = NEW.parent_id AND parent_id IS NOT NULL) THEN
        RAISE EXCEPTION 'comment replies may not be nested more than one level';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER comment_depth_guard_trigger
    BEFORE INSERT OR UPDATE OF parent_id ON comment
    FOR EACH ROW EXECUTE FUNCTION comment_depth_guard();

CREATE TABLE comment_mention (
    comment_id uuid NOT NULL REFERENCES comment(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    read_at    timestamptz,
    PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX comment_mention_unread_idx
    ON comment_mention (user_id) WHERE read_at IS NULL;

CREATE TABLE activity (
    id           bigserial PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    actor_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
    verb         text NOT NULL,
    target_type  text NOT NULL,
    target_id    uuid NOT NULL,
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_workspace_idx ON activity (workspace_id, id DESC);
CREATE INDEX activity_actor_idx ON activity (workspace_id, actor_id, id DESC);
CREATE INDEX activity_target_idx ON activity (workspace_id, target_type, target_id, id DESC);
