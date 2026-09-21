export const ISSUE_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
] as const

export type IssueStatus = (typeof ISSUE_STATUSES)[number]

export interface VelvetConfig {
  baseUrl: string
  token: string
  /**
   * The organisation slug. Empty means "discover it from the checkout's git
   * remote", which is what lets one configuration serve every repository.
   */
  workspace: string
  defaultStatus?: IssueStatus
}

export interface RepoResolution {
  workspace_slug: string
  workspace_name?: string
  owner?: string
  name?: string
  project_key?: string | null
  project_name?: string | null
  issue_prefix?: string
}

export interface Project {
  id?: string
  key: string
  name: string
  description?: string
  status?: string
  issue_counts?: Record<string, number>
}

export interface ProjectsResponse {
  projects?: Project[]
}

export interface EvidenceRef {
  kind: string
  id?: string
  sha?: string
  url?: string
}

export interface WorklogEntry {
  day: string
  at: string
  workspace_slug: string
  workspace_name?: string
  project_key?: string | null
  project_name?: string | null
  kind: string
  source?: string
  note_kind?: string | null
  issue_key?: string | null
  title?: string
  body?: string
  url?: string
  status?: string
}

export interface WorklogResponse {
  entries?: WorklogEntry[]
}

export interface User {
  id?: string
  email?: string
  github_login?: string
  name?: string
}

export interface Membership {
  workspace_slug?: string
  workspace_name?: string
  slug?: string
  name?: string
  role?: string
}

export interface MeResponse {
  user?: User
  memberships?: Membership[]
}

export interface Issue {
  id?: string
  key: string
  title: string
  description?: string
  status?: string
  priority?: number
  assignee_id?: string | null
  milestone_id?: string | null
  created_at?: string
  updated_at?: string
}

export interface Comment {
  id?: string
  body: string
  created_at?: string
  author?: User
  replies?: Comment[]
}

export interface CommentsResponse {
  comments?: Comment[]
}

export interface IssuesResponse {
  issues?: Issue[]
  next_cursor?: string
}

export interface Milestone {
  id: string
  name: string
  status?: string
  target_date?: string | null
  sprint_id?: string
  issue_counts?: Record<string, number>
}

export type SprintState = 'upcoming' | 'active' | 'completed'

/** A sprint is a calendar month: the window work is scheduled into. */
export interface Sprint {
  id: string
  name: string
  starts_on: string
  ends_on: string
  state: SprintState
}

export interface SprintsResponse {
  sprints?: Sprint[]
}

export interface MilestonesResponse {
  milestones?: Milestone[]
}

export interface CreateIssueInput {
  title: string
  description?: string
  status?: IssueStatus
  priority?: number
  project?: string
  milestone_id?: string
}

/** Status is deliberately absent: it changes only on an explicit request. */
export interface UpdateIssueInput {
  title?: string
  description?: string
  priority?: number
  project?: string
  milestone_id?: string | null
}

export interface TicketDetails {
  issue: Issue
  comments: Comment[]
}
