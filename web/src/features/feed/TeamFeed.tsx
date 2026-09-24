import { useState } from 'react'

import { useStream } from '../../lib/useStream'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
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
  const hasFilters = Boolean(filters.actor_id || filters.verb || filters.target_type)

  return (
    <div className="w-full min-w-0">
      <PageHeader
        title="Team feed"
        description="Follow the comments, status changes, evidence, and planning updates made across the organisation."
      />

      <div className="ui-surface mb-4 grid gap-3 bg-grey-100 p-3 text-sm sm:grid-cols-3">
        <label className="min-w-0">
          <span className="mb-1 block text-xs text-grey-500">Person</span>
          <select
            className="ui-control min-h-10 w-full px-2 py-1 text-sm leading-5 md:min-h-8"
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

        <label className="min-w-0">
          <span className="mb-1 block text-xs text-grey-500">Activity</span>
          <select
            aria-label="Verb"
            className="ui-control min-h-10 w-full px-2 py-1 text-sm leading-5 md:min-h-8"
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

        <label className="min-w-0">
          <span className="mb-1 block text-xs text-grey-500">Work type</span>
          <select
            className="ui-control min-h-10 w-full px-2 py-1 text-sm leading-5 md:min-h-8"
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
        <LoadingState />
      ) : query.error && rows.length === 0 ? (
        <ErrorState
          message="Could not load the team feed."
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
      ) : rows.length === 0 ? (
        hasFilters ? (
          <EmptyState
            title="No matching activity"
            message="Nothing matches these filters."
            action={<Button onClick={() => setFilters({})}>Clear filters</Button>}
          />
        ) : (
          <EmptyState title="Nothing here yet" message="Activity appears as the team works." />
        )
      ) : (
        <div className="divide-y divide-grey-200 rounded-[var(--radius-surface)] border border-grey-200">
          {rows.map((a) => (
            <div key={a.id} className="px-3 py-2 transition-colors hover:bg-grey-100">
              <ActivityRow activity={a} />
            </div>
          ))}
        </div>
      )}

      {query.error && rows.length > 0 ? (
        <p role="alert" className="mt-3 text-sm text-blocked">
          Could not load more activity. Try again.
        </p>
      ) : null}

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
