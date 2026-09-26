// The API's snake_case JSON is used verbatim rather than camelCased, so there
// is no mapping layer to drift out of sync with the Go structs.

export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelled'

export type MilestoneStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled'

export type SprintState = 'upcoming' | 'active' | 'completed'

export type Role = 'admin' | 'member' | 'viewer'

export interface User {
  id: string
  email?: string
  github_id?: number | null
  github_login: string | null
  name: string
  avatar_url: string
}

export interface Membership {
  id: string
  workspace_id: string
  workspace_slug: string
  workspace_name: string
  issue_prefix: string
  role: Role
}

export interface Workspace {
  id: string
  name: string
  slug: string
  issue_prefix: string
}

export interface WorkspaceMembership {
  id: string
  workspace_id: string
  role: Role
  user: User
}

export interface SessionPayload {
  user: User
  memberships: Membership[]
  last_workspace: Membership | null
}

export interface Invitation {
  id: string
  workspace_id: string
  workspace_slug: string
  workspace_name: string
  email: string
  role: Role
  expires_at: string
}

export interface Label {
  id: string
  workspace_id: string
  name: string
  color: string
}

export interface Issue {
  id: string
  workspace_id: string
  key: string
  number: number
  title: string
  description: string
  status: IssueStatus
  priority: number
  assignee_id: string | null
  milestone_id: string | null
  project_id: string | null
  parent_id: string | null
  position: string
  created_by: string | null
  created_at: string
  updated_at: string
  labels?: Label[]
  children?: Issue[]
}

export type ProjectStatus = 'active' | 'archived'

/**
 * A project is the durable unit of work inside an organisation. Unlike a
 * milestone it outlives the sprint its issues are scheduled into.
 */
export interface Project {
  id: string
  workspace_id: string
  key: string
  name: string
  description: string
  status: ProjectStatus
  created_at: string
  updated_at: string
  archived_at: string | null
  issue_counts?: Record<string, number>
}

/** One thing a person did, in one organisation, on one day. */
export interface WorklogEntry {
  day: string
  at: string
  workspace_slug: string
  workspace_name: string
  project_key: string | null
  project_name: string | null
  kind: 'note' | 'issue' | 'pull_request' | 'commit'
  source?: string
  note_kind?: string | null
  issue_key?: string | null
  title: string
  body?: string
  url?: string
  status?: string
}

export interface Comment {
  id: string
  workspace_id: string
  target_type: string
  target_id: string
  parent_id: string | null
  author: User
  body: string
  created_at: string
  edited_at: string | null
  deleted_at: string | null
  replies?: Comment[]
}

export interface Milestone {
  id: string
  workspace_id: string
  sprint_id: string
  name: string
  description: string
  owner_id: string | null
  target_date: string | null
  status: MilestoneStatus
  position: string
  created_at: string
  updated_at: string
  issue_counts?: Record<string, number>
  last_comment?: Pick<Comment, 'id' | 'body' | 'created_at'> | null
}

export interface Sprint {
  id: string
  workspace_id: string
  name: string
  starts_on: string
  ends_on: string
  state: SprintState
  created_at: string
  completed_at: string | null
}

export interface Activity {
  id: number
  workspace_id: string
  actor: User | null
  verb: string
  target_type: string
  target_id: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface Mention {
  comment: Comment
  read_at: string | null
  target_label: string
}

export interface DashboardPayload {
  activity: Activity[]
  my_issues: Issue[]
  unread_mentions: number
  active_sprint: Sprint | null
  milestones: Milestone[]
}

export interface PullRequest {
  id: string
  workspace_id?: string
  repo_id?: string
  number: number
  title: string
  state: string
  draft: boolean
  author_login: string
  author_id?: string | null
  head_ref?: string
  body?: string
  additions: number
  deletions: number
  html_url: string
  merged_at: string | null
  closed_at?: string | null
  gh_created_at?: string | null
  gh_updated_at?: string | null
}

export interface Repo {
  id: string
  workspace_id: string
  installation_id: number
  github_id: number
  owner: string
  name: string
  default_branch: string
  synced_at: string | null
  disconnected_at: string | null
  /** The project this repository's untracked work files under. */
  project_id?: string | null
}

export interface Review {
  id: string
  pull_request_id: string
  github_id: number
  reviewer_login: string
  state: string
  submitted_at: string
}

export interface Commit {
  sha: string
  issue_id: string | null
  branch: string
  message: string
  author_login: string
  html_url: string
  committed_at: string
}

export interface Evidence {
  pull_requests: PullRequest[]
  reviews: Review[]
  commits: Commit[]
}

export interface PersonActivityRow {
  user_id: string | null
  email: string
  github_login: string | null
  name: string
  verbs: Record<string, number>
  total: number
}

export interface MilestoneCompletionRow {
  sprint_id: string
  sprint_name: string
  starts_on: string
  planned: number
  completed: number
}

export interface SprintClosedRow {
  sprint_id: string
  sprint_name: string
  starts_on: string
  closed: number
  total: number
}

export interface StaleIssueRow {
  id: string
  key: string
  title?: string
  status: IssueStatus
  assignee_email?: string
  assignee_login: string | null
  assignee_name?: string
  milestone_name?: string
  last_signal_at?: string
  days_silent: number
}

export interface SprintSnapshot {
  sprint_id: string
  workspace_id: string
  milestones_planned: number
  milestones_completed: number
  issue_counts: Record<string, number>
  person_totals: Record<string, number>
  captured_at: string
}
