import type { Issue, SprintState } from '../../lib/types'

/**
 * An active sprint also shows its project's work that has no milestone yet,
 * so nothing unscheduled drops out of sight. Other projects run their own
 * sprints, so their unfiled work stays on their boards.
 */
export function issuesForSprint<T extends Issue>(
  state: SprintState,
  sprintIssues: T[],
  unfiledIssues: T[],
  projectId?: string,
): T[] {
  if (state !== 'active') return sprintIssues

  const merged = new Map(sprintIssues.map((issue) => [issue.id, issue]))
  for (const issue of unfiledIssues) {
    if (issue.milestone_id) continue
    if (projectId && issue.project_id !== projectId) continue
    merged.set(issue.id, issue)
  }
  return [...merged.values()]
}
