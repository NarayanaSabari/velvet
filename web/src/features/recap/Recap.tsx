import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { WorklogEntry } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { StatusBadge } from '../../ui/StatusBadge'

/**
 * The recap answers "what was I working on", across every organisation at
 * once. It deliberately sits outside the workspace shell, because scoping it
 * to one organisation would answer a smaller question than the one people ask.
 */

const RANGES = [
  { days: 1, label: 'Today' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
] as const

const KIND_LABELS: Record<WorklogEntry['kind'], string> = {
  note: 'Note',
  issue: 'Ticket',
  pull_request: 'Pull request',
  commit: 'Commit',
}

function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00`)
  if (Number.isNaN(date.getTime())) return day
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

/** Groups by day, then by organisation, the way a person rebuilds their week. */
function groupEntries(entries: WorklogEntry[]) {
  const days: { day: string; workspaces: { slug: string; name: string; entries: WorklogEntry[] }[] }[] = []
  for (const entry of entries) {
    let day = days.at(-1)
    if (!day || day.day !== entry.day) {
      day = { day: entry.day, workspaces: [] }
      days.push(day)
    }
    let workspace = day.workspaces.at(-1)
    if (!workspace || workspace.slug !== entry.workspace_slug) {
      workspace = { slug: entry.workspace_slug, name: entry.workspace_name, entries: [] }
      day.workspaces.push(workspace)
    }
    workspace.entries.push(entry)
  }
  return days
}

function EntryRow({ entry }: { entry: WorklogEntry }) {
  // A note's body is the record of what happened; everything else is named by
  // its title.
  const text = entry.kind === 'note' ? entry.body ?? '' : entry.title
  const body = entry.url ? (
    <a className="underline" href={entry.url} target="_blank" rel="noreferrer">
      {text || entry.url}
    </a>
  ) : (
    text
  )

  return (
    <li className="py-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 text-xs text-grey-500">{KIND_LABELS[entry.kind]}</span>
        {entry.project_key ? (
          <span className="shrink-0 font-mono text-xs text-grey-500">{entry.project_key}</span>
        ) : null}
        {entry.issue_key ? (
          <span className="shrink-0 font-mono text-xs text-ink">{entry.issue_key}</span>
        ) : null}
        {entry.source === 'agent' ? (
          <span className="shrink-0 text-xs text-grey-500">agent</span>
        ) : null}
        {entry.note_kind ? (
          <span className="shrink-0 text-xs text-grey-500">{entry.note_kind}</span>
        ) : null}
        {entry.kind === 'issue' && entry.status ? (
          <StatusBadge status={entry.status as never} />
        ) : null}
      </div>
      <p className="mt-1 min-w-0 break-words text-ink">{body}</p>
    </li>
  )
}

export function Recap() {
  const [days, setDays] = useState<number>(7)
  const query = useQuery({
    queryKey: ['worklog', days],
    queryFn: () => api.get<{ entries: WorklogEntry[] }>(`/me/worklog?days=${days}`),
  })

  const grouped = useMemo(() => groupEntries(query.data?.entries ?? []), [query.data])

  return (
    <div className="max-w-[80rem] min-w-0">
      <PageHeader
        title="Work log"
        description="Rebuild your week from notes, tickets, pull requests, and agent progress across every organisation."
        actions={<>
        <label className="text-sm text-grey-500">
          <span className="sr-only">Period</span>
          <select
            className="ui-control min-h-10 px-2 py-1 text-sm md:min-h-8"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {RANGES.map((range) => (
              <option key={range.days} value={range.days}>
                {range.label}
              </option>
            ))}
          </select>
        </label>
        <a className="text-sm underline" href={`/api/v1/me/worklog.md?days=${days}`}>
          Copy as Markdown
        </a>
        </>}
      />

      {query.isPending ? (
        <LoadingState label="Loading your work log…" />
      ) : query.error ? (
        <ErrorState
          message="Could not load your work log."
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          title="No recorded work in this period"
          message="Work appears here as you and your agents log it, in every organisation you belong to."
        />
      ) : (
        <div className="space-y-6">
          {grouped.map((day) => (
            <section key={day.day} className="space-y-3">
              <h2 className="border-b border-grey-200 pb-2 text-sm font-medium text-ink">{dayLabel(day.day)}</h2>
              {day.workspaces.map((workspace) => (
                <div key={`${day.day}-${workspace.slug}`}>
                  <h3 className="mb-1 text-xs font-medium text-grey-500">
                    {workspace.name}
                  </h3>
                  <ul className="divide-y divide-grey-200 rounded-[var(--radius-surface)] border border-grey-200 px-3">
                    {workspace.entries.map((entry, index) => (
                      <EntryRow key={`${entry.at}-${entry.kind}-${index}`} entry={entry} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
