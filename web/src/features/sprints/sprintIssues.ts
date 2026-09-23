import type { Issue, SprintState } from '../../lib/types'

export function issuesForSprint<T extends Issue>(
  state: SprintState,
  sprintIssues: T[],
  unfiledIssues: T[],
): T[] {
  if (state !== 'active') return sprintIssues

  const merged = new Map(sprintIssues.map((issue) => [issue.id, issue]))
  for (const issue of unfiledIssues) {
    if (!issue.milestone_id) merged.set(issue.id, issue)
  }
  return [...merged.values()]
}
