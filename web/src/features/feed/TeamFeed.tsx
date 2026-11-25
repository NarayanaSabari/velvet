import { ErrorNote } from '../../ui/ErrorNote'
import { List, ListItem } from '@astryxdesign/core/List'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { ActivityRow } from '../activity/ActivityRow'
import { useActivity, type ActivityFilters } from '../activity/useActivity'
import { useSession } from '../auth/useSession'
import { userLabel } from '../../lib/userLabel'
import { membersQuery } from '../work/workLinks'
import { SelectField } from '../../ui/fields'

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
  const session = useSession(slug)
  const members = useQuery(membersQuery(slug))
  const people = members.data?.members ?? (session.user ? [session.user] : [])
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

      {/* The filters sit on the page, as on Issues, with a rule beneath. */}
      <div className="mb-2 grid gap-3 border-b border-grey-200 pb-4 sm:grid-cols-3 xl:max-w-3xl">
        <SelectField
          label="Person"
          value={filters.actor_id ?? ''}
          onChange={(value) => setFilters((f) => ({ ...f, actor_id: value || undefined }))}
          options={[
            { value: '', label: 'Everyone' },
            ...people.map((person) => ({ value: person.id, label: userLabel(person) })),
          ]}
        />

        <SelectField
          label="Activity"
          aria-label="Verb"
          value={filters.verb ?? ''}
          onChange={(value) => setFilters((f) => ({ ...f, verb: value || undefined }))}
          options={[
            { value: '', label: 'All activity' },
            ...VERBS.map((verb) => ({ value: verb, label: VERB_LABELS[verb] ?? verb })),
          ]}
        />

        <SelectField
          label="Work type"
          value={filters.target_type ?? ''}
          onChange={(value) => setFilters((f) => ({ ...f, target_type: value || undefined }))}
          options={[
            { value: '', label: 'Issues and milestones' },
            { value: 'issue', label: 'Issues' },
            { value: 'milestone', label: 'Milestones' },
          ]}
        />
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
        <div className="border-b border-grey-200">
          <List hasDividers density="balanced" edge="flush" aria-label="Team activity">
            {rows.map((a) => (
              <ListItem key={a.id} itemKey={a.id} label={<ActivityRow activity={a} slug={slug} />} />
            ))}
          </List>
        </div>
      )}

      {query.error && rows.length > 0 ? (
        <ErrorNote className="mt-3">
          Could not load more activity. Try again.
        </ErrorNote>
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
