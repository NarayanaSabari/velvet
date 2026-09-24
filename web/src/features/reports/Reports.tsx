import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { api } from '../../lib/api'
import { userLabel } from '../../lib/userLabel'
import type {
  MilestoneCompletionRow,
  PersonActivityRow,
  SprintClosedRow,
  StaleIssueRow,
} from '../../lib/types'
import { NavLink } from '../../app/nav'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { STATUS_LABELS } from '../../ui/StatusBadge'

/** Four plain tables. Numbers in a monochrome table are read faster than a
 *  chart at this scale, and a chart would need colour the design does not
 *  have. The only colour here is amber on a stale row, next to the day count
 *  in words, so the state is legible without depending on hue. */

function Section({ title, note, children }: {
  title: string
  note?: string
  children: ReactNode
}) {
  return (
    <section className="mb-8">
      <SectionHeader title={title} />
      {note ? <p className="mb-3 text-sm text-grey-500">{note}</p> : null}
      {children}
    </section>
  )
}

/** One report's own loading and failure, so a single failed request neither
 *  blanks the page nor leaves its section waiting forever. */
function ReportBody<T>({ query, name, children }: {
  query: UseQueryResult<T>
  name: string
  children: (data: T) => ReactNode
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>
  if (query.error) {
    return (
      <ErrorState
        message={`Could not load ${name}.`}
        onRetry={() => void query.refetch()}
        retrying={query.isRefetching}
      />
    )
  }
  return <LoadingState />
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-[var(--radius-surface)] border border-grey-200">
      <table className="w-full min-w-[36rem] text-sm [overflow-wrap:anywhere]">
        <thead className="bg-grey-100">
          <tr className="border-b border-grey-200 text-left text-xs text-grey-500">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-grey-200 [&_td]:px-3 [&_td]:py-2">{children}</tbody>
      </table>
    </div>
  )
}

function Nothing({ message }: { message: string }) {
  return <p className="border-y border-grey-200 py-3 text-sm text-grey-500">{message}</p>
}

export function PersonActivityTable({ rows }: { rows: PersonActivityRow[] }) {
  if (rows.length === 0) return <Nothing message="No activity in this period." />
  return (
    <Table head={['Person', 'Comments', 'Status changes', 'Issues created', 'Total']}>
      {rows.map((row) => (
        <tr key={row.user_id ?? row.github_login ?? 'system'}>
          <td className="py-1 pr-4">{row.user_id ? userLabel(row) : 'System'}</td>
          <td className="py-1 pr-4 tabular-nums">{row.verbs.commented ?? 0}</td>
          <td className="py-1 pr-4 tabular-nums">{row.verbs.changed_status ?? 0}</td>
          <td className="py-1 pr-4 tabular-nums">{row.verbs.created_issue ?? 0}</td>
          <td className="py-1 pr-4 tabular-nums">{row.total}</td>
        </tr>
      ))}
    </Table>
  )
}

export function MilestoneCompletionTable({ rows }: { rows: MilestoneCompletionRow[] }) {
  if (rows.length === 0) return <Nothing message="No sprints yet." />
  return (
    <Table head={['Sprint', 'Completed', 'Planned', 'Rate']}>
      {rows.map((row) => (
        <tr key={row.sprint_id}>
          <td className="py-1 pr-4">{row.sprint_name}</td>
          <td className="py-1 pr-4 tabular-nums">{row.completed}</td>
          <td className="py-1 pr-4 tabular-nums">{row.planned}</td>
          <td className="py-1 pr-4 tabular-nums">
            {row.planned === 0 ? '—' : `${Math.round((row.completed / row.planned) * 100)}%`}
          </td>
        </tr>
      ))}
    </Table>
  )
}

export function ClosedPerSprintTable({ rows }: { rows: SprintClosedRow[] }) {
  if (rows.length === 0) return <Nothing message="No sprints yet." />
  return (
    <Table head={['Sprint', 'Closed', 'Total issues']}>
      {rows.map((row) => (
        <tr key={row.sprint_id}>
          <td className="py-1 pr-4">{row.sprint_name}</td>
          <td className="py-1 pr-4 tabular-nums">{row.closed}</td>
          <td className="py-1 pr-4 tabular-nums">{row.total}</td>
        </tr>
      ))}
    </Table>
  )
}

export function StaleTable({ rows, slug }: { rows: StaleIssueRow[]; slug?: string }) {
  if (rows.length === 0) return <Nothing message="Nothing has stalled." />
  return (
    <Table head={['Issue', 'Title', 'Status', 'Assignee', 'Silent for']}>
      {rows.map((row) => (
        <tr key={row.id}>
          <td className="py-1 pr-4 whitespace-nowrap">
            {slug ? (
              <NavLink to={`/w/${slug}/issues/${row.key}`}>{row.key}</NavLink>
            ) : (
              row.key
            )}
          </td>
          <td className="py-1 pr-4">{row.title ?? ''}</td>
          <td className="py-1 pr-4 whitespace-nowrap">{STATUS_LABELS[row.status]}</td>
          <td className="py-1 pr-4 whitespace-nowrap">
            {row.assignee_email || row.assignee_login || row.assignee_name ? userLabel({
              name: row.assignee_name, email: row.assignee_email, github_login: row.assignee_login,
            }) : 'Unassigned'}
          </td>
          {/* Words first, amber second: the count reads without the colour. */}
          <td className="py-1 pr-4 whitespace-nowrap text-stale">
            {row.days_silent} days
          </td>
        </tr>
      ))}
    </Table>
  )
}

const STALE_DAYS = 14

export function Reports({ slug }: { slug: string }) {
  const people = useQuery({
    queryKey: ['reports', slug, 'activity'],
    queryFn: () => api.get<{ people: PersonActivityRow[] }>(`/w/${slug}/reports/activity`),
  })
  const milestones = useQuery({
    queryKey: ['reports', slug, 'milestones'],
    queryFn: () =>
      api.get<{ sprints: MilestoneCompletionRow[] }>(`/w/${slug}/reports/milestones`),
  })
  const closed = useQuery({
    queryKey: ['reports', slug, 'closed'],
    queryFn: () => api.get<{ sprints: SprintClosedRow[] }>(`/w/${slug}/reports/closed`),
  })
  const stale = useQuery({
    queryKey: ['reports', slug, 'stale', STALE_DAYS],
    queryFn: () =>
      api.get<{ issues: StaleIssueRow[] }>(`/w/${slug}/reports/stale?days=${STALE_DAYS}`),
  })

  return (
    <div className="w-full min-w-0">
      <PageHeader
        title="Reports"
        description="See where work is moving, where it is quiet, and how each sprint is closing."
      />

      <Section
        title="Stale work"
        note={`Open issues with no comment, status change, or pull request activity in ${STALE_DAYS} days.`}
      >
        <ReportBody query={stale} name="stale work">
          {(data) => <StaleTable rows={data.issues} slug={slug} />}
        </ReportBody>
      </Section>

      <Section title="Activity per person">
        <ReportBody query={people} name="activity per person">
          {(data) => <PersonActivityTable rows={data.people} />}
        </ReportBody>
      </Section>

      <Section title="Milestone completion per sprint">
        <ReportBody query={milestones} name="milestone completion">
          {(data) => <MilestoneCompletionTable rows={data.sprints} />}
        </ReportBody>
      </Section>

      <Section title="Issues closed per sprint">
        <ReportBody query={closed} name="issues closed per sprint">
          {(data) => <ClosedPerSprintTable rows={data.sprints} />}
        </ReportBody>
      </Section>
    </div>
  )
}
