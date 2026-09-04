import { useQuery } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Milestone, Sprint } from '../../lib/types'
import { NavLink } from '../../app/nav'
import { EmptyState } from '../../ui/EmptyState'
import { RelativeTime } from '../../ui/RelativeTime'

/** Two weeks of silence on a milestone is the signal this product exists to
 *  surface, so it is stated in words and only then reinforced with amber. */
const STALE_DAYS = 14

export function daysSince(iso: string, now: number = Date.now()): number {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 0
  return Math.floor((now - then) / 864e5)
}

function counts(milestone: Milestone) {
  const byStatus = milestone.issue_counts ?? {}
  const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0)
  return { done: byStatus.done ?? 0, total }
}

export function MilestoneRow({ milestone, slug }: { milestone: Milestone; slug?: string }) {
  const { done, total } = counts(milestone)
  const last = milestone.last_comment ?? null
  const age = last ? daysSince(last.created_at) : null
  const stale = age === null || age >= STALE_DAYS

  const name = slug ? (
    <NavLink to={`/w/${slug}/milestones/${milestone.id}`} className="text-ink">
      {milestone.name}
    </NavLink>
  ) : (
    <span className="text-ink">{milestone.name}</span>
  )

  return (
    <div className="py-1.5 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="text-grey-500">
          {done}/{total}
        </span>
        {last ? <RelativeTime iso={last.created_at} /> : null}
      </div>

      <div className="mt-0.5 flex items-baseline gap-2">
        {last ? (
          <span className="min-w-0 flex-1 truncate text-grey-700">{last.body}</span>
        ) : (
          <span className="min-w-0 flex-1 text-grey-500">
            Nobody has written an update here
          </span>
        )}
        {stale ? (
          // Words first, colour second: the state is readable without hue.
          <span className="border border-stale px-1 text-xs whitespace-nowrap text-stale">
            {age === null ? 'No updates yet' : `No update in ${age} days`}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function SprintBoard({ slug, sprintId }: { slug: string; sprintId: string }) {
  const sprint = useQuery({
    queryKey: ['sprint', slug, sprintId],
    queryFn: () => api.get<Sprint>(`/w/${slug}/sprints/${sprintId}`),
  })
  const milestones = useQuery({
    queryKey: ['milestones', slug, sprintId],
    queryFn: () =>
      api.get<{ milestones: Milestone[] }>(`/w/${slug}/sprints/${sprintId}/milestones`),
  })

  if (milestones.isPending) return <p className="text-grey-500">Loading…</p>
  if (milestones.error) return <p className="text-blocked">Could not load this sprint.</p>

  const rows = milestones.data.milestones

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-lg">{sprint.data?.name ?? 'Sprint'}</h1>
      {sprint.data ? (
        <p className="mb-4 text-sm text-grey-500">
          {sprint.data.starts_on} to {sprint.data.ends_on} · {sprint.data.state}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title="No milestones in this sprint" />
      ) : (
        <div className="divide-y divide-grey-200 border-y border-grey-200">
          {rows.map((m) => (
            <MilestoneRow key={m.id} milestone={m} slug={slug} />
          ))}
        </div>
      )}
    </div>
  )
}
