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
  github_id?: number
  github_login: string
  name: string
  avatar_url: string
}

export interface Membership {
  id: string
  workspace_id: string
  workspace_slug: string
  workspace_name: string
  role: Role
}

export interface SessionPayload {
  user: User
  memberships: Membership[]
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
  parent_id: string | null
  position: string
  created_by: string | null
  created_at: string
  updated_at: string
  labels?: Label[]
  children?: Issue[]
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
}

export interface DashboardPayload {
  activity: Activity[]
  my_issues: Issue[]
  unread_mentions: number
  active_sprint: Sprint | null
  milestones: Milestone[]
}
