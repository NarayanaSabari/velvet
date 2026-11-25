import type { Issue, Milestone, Sprint } from '../../lib/types'

/** A calendar date as a whole number of days, so sprints can be measured and placed. */
export function dayNumber(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!match) return Number.NaN
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 864e5)
}

export function todayNumber(): number {
  const now = new Date()
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 864e5)
}

/** A sprint's length in days, counting both its first and last day. */
export function sprintLength(sprint: Sprint): number {
  return dayNumber(sprint.ends_on) - dayNumber(sprint.starts_on) + 1
}

/** How far the share of finished issues may trail the share of days gone before a sprint is called behind. */
export const BEHIND_MARGIN = 0.25

/**
 * Whether a running sprint's finished work trails its calendar. Work tends
 * to finish late in a sprint, so nothing is said in the first half, and
 * after that only when the share of issues done is at least 25 points under
 * the share of days gone. A sprint with no issues is not judged.
 */
export function isBehind({ day, length, done, total }: { day: number; length: number; done: number; total: number }): boolean {
  if (total <= 0 || length <= 0) return false
  const timeGone = day / length
  if (timeGone < 0.5) return false
  return timeGone - done / total >= BEHIND_MARGIN
}

/** Where a running sprint stands: which day it is on, out of how many. */
export function sprintProgress(sprint: Sprint) {
  const length = sprintLength(sprint)
  const day = Math.min(Math.max(todayNumber() - dayNumber(sprint.starts_on) + 1, 0), length)
  return { day, length, left: length - day }
}

/** Issues filed under a sprint's milestones: how many are finished, and how many there are. */
export function milestoneWork(milestones: Milestone[]): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const milestone of milestones) {
    const counts = milestone.issue_counts ?? {}
    done += counts.done ?? 0
    for (const count of Object.values(counts)) total += Number.isFinite(count) ? count : 0
  }
  return { done, total }
}

/** A list of issues as finished and total. Cancelled work is neither: it will not be done. */
export function issueWork(issues: Issue[]): { done: number; total: number } {
  const counted = issues.filter((issue) => issue.status !== 'cancelled')
  return { done: counted.filter((issue) => issue.status === 'done').length, total: counted.length }
}

/**
 * The issues a running sprint is answerable for: those under its milestones,
 * and its project's issues that have no milestone yet. This is the same set
 * the sprint's own page lists.
 */
export function issuesInSprint<T extends Issue>(sprint: Sprint, milestones: Milestone[], issues: T[]): T[] {
  const ids = new Set(milestones.map((milestone) => milestone.id))
  return issues.filter((issue) =>
    issue.milestone_id ? ids.has(issue.milestone_id) : issue.project_id === sprint.project_id)
}

/**
 * The one reading of a running sprint's pace, used wherever it is shown so
 * every page agrees: its place in the calendar, its finished work, and
 * whether that work is behind.
 */
export function sprintPace(sprint: Sprint, work: { done: number; total: number }) {
  const progress = sprintProgress(sprint)
  return {
    ...progress,
    ...work,
    behind: sprint.state === 'active' && isBehind({ ...progress, ...work }),
    timeGone: progress.length > 0 ? Math.round((progress.day / progress.length) * 100) : 0,
  }
}
