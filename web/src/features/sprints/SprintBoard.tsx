import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Milestone, Sprint, User } from '../../lib/types'
import { NavLink } from '../../app/nav'
import { EmptyState } from '../../ui/EmptyState'
import { RelativeTime } from '../../ui/RelativeTime'
import { Button } from '../../ui/Button'
import { useSession } from '../auth/useSession'
import { MilestoneForm, type MilestoneInput } from '../work/CoreForms'

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
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'
  const sprint = useQuery({
    queryKey: ['sprint', slug, sprintId],
    queryFn: () => api.get<Sprint>(`/w/${slug}/sprints/${sprintId}`),
  })
  const milestones = useQuery({
    queryKey: ['milestones', slug, sprintId],
    queryFn: () =>
      api.get<{ milestones: Milestone[] }>(`/w/${slug}/sprints/${sprintId}/milestones`),
  })
  const members = useQuery({
    queryKey: ['members', slug],
    queryFn: () => api.get<{ members: User[] }>(`/w/${slug}/members`),
  })
  const createMilestone = useMutation({
    mutationFn: (input: MilestoneInput) =>
      api.post<Milestone>(`/w/${slug}/sprints/${sprintId}/milestones`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['milestones', slug, sprintId] }),
  })
  const changeState = useMutation({
    mutationFn: (action: 'activate' | 'close') =>
      api.post<Sprint>(`/w/${slug}/sprints/${sprintId}/${action}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint', slug, sprintId] })
      void queryClient.invalidateQueries({ queryKey: ['sprints', slug] })
    },
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

      {workspace?.role === 'admin' && sprint.data?.state !== 'completed' ? (
        <div className="mb-4 flex gap-2">
          {sprint.data?.state === 'upcoming' ? (
            <Button disabled={changeState.isPending} onClick={() => changeState.mutate('activate')}>
              Activate sprint
            </Button>
          ) : null}
          {sprint.data?.state === 'active' ? (
            <Button variant="danger" disabled={changeState.isPending} onClick={() => changeState.mutate('close')}>
              Close sprint
            </Button>
          ) : null}
        </div>
      ) : null}

      {canWrite && sprint.data?.state !== 'completed' ? (
        <details className="mb-4">
          <summary className="cursor-pointer text-sm underline">New milestone</summary>
          <div className="mt-2">
            <MilestoneForm
              members={(members.data?.members ?? []).map((member) => ({
                id: member.id, label: member.github_login,
              }))}
              onSubmit={(input) => createMilestone.mutateAsync(input)}
            />
          </div>
        </details>
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
