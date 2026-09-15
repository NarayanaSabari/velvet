import type { Comment, Issue, Milestone, TicketDetails, User } from './types.js'

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
