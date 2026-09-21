import type {
  Comment,
  EvidenceRef,
  Issue,
  Milestone,
  Project,
  TicketDetails,
  User,
  WorklogEntry,
} from './types.js'

function text(value: unknown, fallback = '?'): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return fallback
  }
  return String(value).replace(/[\t\r\n]+/g, ' ').trim() || fallback
}

function authorName(author?: User): string {
  return text(author?.name || author?.github_login || author?.email, 'unknown user')
}

function assignee(issue: Issue): string {
  return issue.assignee_id ? text(issue.assignee_id) : 'unassigned'
}

function commentLine(comment: Comment): string {
  const stamp = comment.created_at ? ` [${text(comment.created_at)}]` : ''
  return `- ${authorName(comment.author)}${stamp}: ${text(comment.body, '(empty)')}`
}

export function formatIssueList(issues: Issue[], workspace: string): string {
  if (issues.length === 0) {
    return `No issues found in workspace ${workspace}.`
  }
  return [
    `Issues in ${workspace}:`,
    ...issues.map(
      (issue) =>
        `${text(issue.key)} | ${text(issue.status)} | ${text(issue.title, '(untitled)')} | assignee: ${assignee(issue)}`,
    ),
  ].join('\n')
}

export function formatTicket(details: TicketDetails, workspace: string): string {
  const { issue, comments } = details
  const lines = [
    `${text(issue.key)}: ${text(issue.title, '(untitled)')}`,
    `Workspace: ${workspace}`,
    `Status: ${text(issue.status)}`,
    `Priority: ${text(issue.priority)}`,
    `Assignee: ${assignee(issue)}`,
  ]
  if (issue.milestone_id) {
    lines.push(`Milestone: ${text(issue.milestone_id)}`)
  }
  if (issue.description?.trim()) {
    lines.push(`Description: ${issue.description.trim()}`)
  }

  const recent = comments.slice(-10)
  lines.push(`Recent comments (${recent.length}):`)
  if (recent.length === 0) {
    lines.push('- (none)')
  } else {
    for (const comment of recent) {
      lines.push(commentLine(comment))
      for (const reply of comment.replies ?? []) {
        lines.push(`  ${commentLine(reply)}`)
      }
    }
  }
  return lines.join('\n')
}

export function formatCreatedTicket(issue: Issue, url: string): string {
  return [
    `Created ${text(issue.key)}: ${text(issue.title, '(untitled)')}`,
    `Status: ${text(issue.status)}`,
    `URL: ${url}`,
  ].join('\n')
}

export function formatLoggedWork(key: string, comment: Comment): string {
  return `Logged worklog to ${text(key)}: ${text(comment.body, '(empty)')}`
}

export function formatStatusUpdate(issue: Issue, requestedStatus: string): string {
  return `${text(issue.key)} status set to ${text(issue.status, requestedStatus)}.`
}

export function formatMilestones(milestones: Milestone[], workspace: string): string {
  if (milestones.length === 0) {
    return `No milestones found in workspace ${workspace}.`
  }
  return [
    `Milestones in ${workspace}:`,
    ...milestones.map((milestone) => {
      const status = milestone.status ? ` | ${text(milestone.status)}` : ''
      return `${text(milestone.id)} | ${text(milestone.name, '(unnamed)')}${status}`
    }),
  ].join('\n')
}

export function formatProjects(projects: Project[], workspace: string): string {
  if (projects.length === 0) {
    return `No projects found in workspace ${workspace}. Create one before filing work under a goal.`
  }
  return [
    `Projects in ${workspace}:`,
    ...projects.map((project) => {
      const counts = Object.entries(project.issue_counts ?? {})
        .map(([status, n]) => `${status}: ${n}`)
        .join(', ')
      return `${text(project.key)} | ${text(project.name, '(unnamed)')}${counts ? ` | ${counts}` : ''}`
    }),
  ].join('\n')
}

export function formatProjectNote(project: string, comment: Comment): string {
  return `Logged work to project ${text(project)}: ${text(comment.body, '(empty)')}`
}

export function formatEvidence(key: string, evidence: EvidenceRef): string {
  const what = evidence.kind === 'commit' ? `commit ${text(evidence.sha)}` : 'pull request'
  const url = evidence.url ? ` (${evidence.url})` : ''
  return `Attached ${what} to ${text(key)} as evidence${url}. Status unchanged.`
}

/**
 * Groups by day then organisation, which is how a person reconstructs their
 * own week when asked what they have been working on.
 */
export function formatWorklog(entries: WorklogEntry[]): string {
  if (entries.length === 0) {
    return 'No recorded work in this period.'
  }

  const lines: string[] = []
  let day = ''
  let workspace = ''
  for (const entry of entries) {
    if (entry.day !== day) {
      day = entry.day
      workspace = ''
      lines.push(`\n${text(entry.day)}`)
    }
    if (entry.workspace_slug !== workspace) {
      workspace = entry.workspace_slug
      lines.push(`  ${text(entry.workspace_name || entry.workspace_slug)}`)
    }
    lines.push(`    - ${worklogLine(entry)}`)
  }
  return lines.join('\n').trim()
}

function worklogLine(entry: WorklogEntry): string {
  const parts: string[] = []
  if (entry.project_key) {
    parts.push(`[${text(entry.project_key)}]`)
  }
  if (entry.issue_key) {
    parts.push(text(entry.issue_key))
  }
  switch (entry.kind) {
    case 'note':
      // The note body is the record of what happened, so it is what is shown.
      parts.push(text(entry.body, '(empty)'))
      break
    case 'issue':
      parts.push(text(entry.title, '(untitled)'))
      if (entry.status) {
        parts.push(`(${text(entry.status)})`)
      }
      break
    case 'pull_request':
      parts.push(`PR: ${text(entry.title, '(untitled)')}`)
      break
    case 'commit':
      parts.push(`commit: ${text(entry.title, '(empty)')}`)
      break
    default:
      parts.push(text(entry.title, '(untitled)'))
  }
  return parts.join(' ')
}
