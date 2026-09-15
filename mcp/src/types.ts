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
  workspace: string
  defaultStatus?: IssueStatus
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
}

export interface MilestonesResponse {
  milestones?: Milestone[]
}

export interface CreateIssueInput {
  title: string
  description?: string
  status?: IssueStatus
  priority?: number
  milestone_id?: string
}

export interface TicketDetails {
  issue: Issue
  comments: Comment[]
}
