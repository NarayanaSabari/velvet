import { useState } from 'react'

import { useStream } from '../../lib/useStream'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { ActivityRow } from '../activity/ActivityRow'
import { useActivity, type ActivityFilters } from '../activity/useActivity'
import { useSession } from '../auth/useSession'
import { userLabel } from '../../lib/userLabel'

const VERBS = [
  'commented',
  'created_issue',
  'changed_status',
  'assigned',
  'attached_pr',
  'completed_milestone',
  'closed_sprint',
] as const

const VERB_LABELS: Record<string, string> = {
  commented: 'Comments',
  created_issue: 'Issues created',
  changed_status: 'Status changes',
  assigned: 'Assignments',
  attached_pr: 'PRs attached',
  completed_milestone: 'Milestones completed',
  closed_sprint: 'Sprints closed',
}

export function TeamFeed({ slug }: { slug: string }) {
  useStream(slug)
  const session = useSession(slug)
  const [filters, setFilters] = useState<ActivityFilters>({})
  const query = useActivity(slug, filters)

  const rows = query.data?.pages.flatMap((page) => page.activity) ?? []

  return (
    <div className="max-w-[80rem]">
      <h1 className="mb-4 text-lg">Team feed</h1>

      <div className="mb-3 flex gap-2 text-sm">
        <label>
          <span className="sr-only">Person</span>
          <select
            className="border border-grey-300 bg-paper px-1 py-0.5"
            value={filters.actor_id ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, actor_id: e.target.value || undefined }))
            }
          >
            <option value="">Everyone</option>
            {session.user ? (
              <option value={session.user.id}>{userLabel(session.user)}</option>
            ) : null}
          </select>
        </label>

        <label>
          <span className="sr-only">Verb</span>
          <select
            className="border border-grey-300 bg-paper px-1 py-0.5"
            value={filters.verb ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, verb: e.target.value || undefined }))}
          >
            <option value="">All activity</option>
            {VERBS.map((verb) => (
              <option key={verb} value={verb}>
                {VERB_LABELS[verb]}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="sr-only">Target</span>
          <select
            className="border border-grey-300 bg-paper px-1 py-0.5"
            value={filters.target_type ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, target_type: e.target.value || undefined }))
            }
          >
            <option value="">Issues and milestones</option>
            <option value="issue">Issues</option>
            <option value="milestone">Milestones</option>
          </select>
        </label>
      </div>

      {query.isPending ? (
        <p className="text-grey-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing here yet" message="Activity appears as the team works." />
      ) : (
        <div className="divide-y divide-grey-200 border-y border-grey-200">
          {rows.map((a) => (
            <div key={a.id} className="py-1.5">
              <ActivityRow activity={a} />
            </div>
          ))}
        </div>
      )}

      {query.hasNextPage ? (
        <Button
          className="mt-3"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  )
}
