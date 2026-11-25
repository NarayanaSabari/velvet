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
import { Table as AstryxTable, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'

import { NavLink } from '../../app/nav'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { STATUS_LABELS } from '../../ui/StatusBadge'

/** Four plain tables, plus one monochrome chart of milestone completion that
 *  sits above its table and never replaces it. The chart is a single series
 *  in ink on a grey track, so it needs no colour the design does not have.
 *  The only colour here is amber on a stale row, next to the day count in
 *  words, so the state is legible without depending on hue. */

function Section({ title, note, children }: {
  title: string
  note?: string
  children: ReactNode
}) {
  return (
    <section className="mb-8">
      <SectionHeader title={title} />
      {note ? <Text as="p" color="secondary" display="block" className="mb-3">{note}</Text> : null}
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

function Table({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <>
    <p className="mb-1 text-xs text-grey-700 sm:hidden">Scroll sideways to see every column.</p>
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="max-w-full overflow-x-auto border-b border-grey-200 [overflow-wrap:anywhere]"
    >
      <AstryxTable density="compact">
        <TableHeader>
          <TableRow isHeaderRow>
            {head.map((h) => (
              <TableHeaderCell key={h} scope="col">{h}</TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </AstryxTable>
    </div>
    </>
  )
}

function Nothing({ message }: { message: string }) {
  return <p className="border-y border-grey-200 py-3 text-sm text-grey-500">{message}</p>
}

export function PersonActivityTable({ rows }: { rows: PersonActivityRow[] }) {
  if (rows.length === 0) return <Nothing message="No activity in this period." />
  return (
    <Table label="Activity per person" head={['Person', 'Comments', 'Status changes', 'Issues created', 'Total']}>
      {rows.map((row) => (
        <TableRow key={row.user_id ?? row.github_login ?? 'system'}>
          <TableCell>{row.user_id ? userLabel(row) : 'System'}</TableCell>
          <TableCell className="tabular-nums">{row.verbs.commented ?? 0}</TableCell>
          <TableCell className="tabular-nums">{row.verbs.changed_status ?? 0}</TableCell>
          <TableCell className="tabular-nums">{row.verbs.created_issue ?? 0}</TableCell>
          <TableCell className="tabular-nums">{row.total}</TableCell>
        </TableRow>
      ))}
    </Table>
  )
}

/** Sprints shown per project. Older ones stay in the table below. */
const TREND_SPRINTS = 8

/** Names a sprint that has not closed, in the words the rest of the app uses
 *  for sprint state, so the chart and the table agree. */
function openSprintLabel(row: MilestoneCompletionRow): string | null {
  if (row.state === 'active') return 'Active'
  if (row.state === 'upcoming') return 'Upcoming'
  return null
}

/** The chart uses the same state words as the table. A soft hyphen lets
 *  "Upcoming" break cleanly onto two lines when a column is too narrow for
 *  it, and is invisible wherever the word fits. */
const CHART_STATE_LABEL: Record<string, string> = {
  Active: 'Active',
  Upcoming: 'Up\u00ADcoming',
}

/** Project by name, then oldest sprint first: the order the chart reads in,
 *  shared with the table so a reader can go from a bar to its row. */
function byProjectThenStart(x: MilestoneCompletionRow, y: MilestoneCompletionRow): number {
  return (x.project_name ?? '').localeCompare(y.project_name ?? '')
    || x.starts_on.localeCompare(y.starts_on)
    || x.sprint_name.localeCompare(y.sprint_name)
}

function completionRate(row: MilestoneCompletionRow): number | null {
  if (row.planned <= 0) return null
  return Math.min(100, Math.max(0, Math.round((row.completed / row.planned) * 100)))
}

/**
 * Completion rate per sprint, one small panel per project, oldest sprint on
 * the left. Every column carries its rate and sprint name as text, so the
 * bars add a shape to scan rather than being the only way to read a value.
 */
export function MilestoneCompletionTrend({ rows }: { rows: MilestoneCompletionRow[] }) {
  if (rows.length === 0) return null

  const byProject = new Map<string, MilestoneCompletionRow[]>()
  for (const row of rows) {
    const name = row.project_name || 'No project'
    byProject.set(name, [...(byProject.get(name) ?? []), row])
  }
  const projects = [...byProject.entries()]
    .map(([name, sprints]) => ({
      name,
      sprints: [...sprints].sort(byProjectThenStart).slice(-TREND_SPRINTS),
    }))
    .sort((x, y) => x.name.localeCompare(y.name))

  return (
    <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="milestone-completion-trend">
      {projects.map((project) => (
        <figure
          key={project.name}
          className="min-w-0 rounded-[var(--radius-surface)] border border-grey-200 p-4"
        >
          <figcaption className="mb-3 text-sm text-ink [overflow-wrap:anywhere]">{project.name}</figcaption>
          {/* Both label rows reserve two lines, so a label that wraps never
              pushes its bar out of line with the others. */}
          <ol className="flex gap-1.5">
            {project.sprints.map((row) => {
              const rate = completionRate(row)
              // A sprint that has not closed is drawn as an outline and named
              // in words, so its low rate is not read as a missed sprint.
              const open = openSprintLabel(row)
              const counts = rate === null
                ? 'no milestones planned'
                : `${row.completed} of ${row.planned} milestones completed${open ? ' so far' : `, ${rate}%`}`
              const summary = `${row.sprint_name}${open ? ` (${open.toLowerCase()})` : ''}: ${counts}`
              return (
                <li key={row.sprint_id} className="min-w-0 flex-1 basis-0 text-center" title={summary}>
                  <span className="sr-only">{summary}</span>
                  <span aria-hidden="true" className="flex h-8 items-end justify-center">
                    <span
                      className={`line-clamp-2 text-xs leading-4 tabular-nums [overflow-wrap:anywhere] ${
                        open ? 'text-grey-500' : 'text-grey-700'
                      }`}
                    >
                      {open ? CHART_STATE_LABEL[open] : rate === null ? '—' : `${rate}%`}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`mx-auto mt-1 flex h-16 w-full max-w-10 items-end overflow-hidden rounded-[4px] ${
                      open ? 'border border-dashed border-grey-500' : 'bg-grey-200'
                    }`}
                  >
                    <span className="block w-full rounded-t-[4px] bg-ink" style={{ height: `${rate ?? 0}%` }} />
                  </span>
                  <span
                    aria-hidden="true"
                    className="mt-1 line-clamp-2 h-8 text-xs leading-4 text-grey-500 [overflow-wrap:anywhere]"
                  >
                    {row.sprint_name}
                  </span>
                </li>
              )
            })}
          </ol>
        </figure>
      ))}
    </div>
  )
}

export function MilestoneCompletionTable({ rows }: { rows: MilestoneCompletionRow[] }) {
  if (rows.length === 0) return <Nothing message="No sprints yet." />
  return (
    <Table label="Milestone completion per sprint" head={['Sprint', 'Project', 'Completed', 'Planned', 'Rate']}>
      {[...rows].sort(byProjectThenStart).map((row) => (
        <TableRow key={row.sprint_id}>
          <TableCell>{row.sprint_name}</TableCell>
          <TableCell>{row.project_name ?? ''}</TableCell>
          <TableCell className="tabular-nums">{row.completed}</TableCell>
          <TableCell className="tabular-nums">{row.planned}</TableCell>
          {openSprintLabel(row) ? (
            <TableCell className="text-grey-500">{openSprintLabel(row)}</TableCell>
          ) : (
            <TableCell className="tabular-nums">
              {row.planned === 0 ? '—' : `${Math.round((row.completed / row.planned) * 100)}%`}
            </TableCell>
          )}
        </TableRow>
      ))}
    </Table>
  )
}

export function ClosedPerSprintTable({ rows }: { rows: SprintClosedRow[] }) {
  if (rows.length === 0) return <Nothing message="No sprints yet." />
  return (
    <Table label="Issues closed per sprint" head={['Sprint', 'Project', 'Closed', 'Total issues']}>
      {rows.map((row) => (
        <TableRow key={row.sprint_id}>
          <TableCell>{row.sprint_name}</TableCell>
          <TableCell>{row.project_name ?? ''}</TableCell>
          <TableCell className="tabular-nums">{row.closed}</TableCell>
          <TableCell className="tabular-nums">{row.total}</TableCell>
        </TableRow>
      ))}
    </Table>
  )
}

export function StaleTable({ rows, slug }: { rows: StaleIssueRow[]; slug?: string }) {
  if (rows.length === 0) return <Nothing message="Nothing has stalled." />
  return (
    <Table label="Stale work" head={['Issue', 'Title', 'Status', 'Assignee', 'Silent for']}>
      {rows.map((row) => (
        <TableRow key={row.id}>
          <TableCell className="whitespace-nowrap">
            {slug ? (
              <NavLink to={`/w/${slug}/issues/${row.key}`}>{row.key}</NavLink>
            ) : (
              row.key
            )}
          </TableCell>
          <TableCell>{row.title ?? ''}</TableCell>
          <TableCell className="whitespace-nowrap">{STATUS_LABELS[row.status]}</TableCell>
          <TableCell className="whitespace-nowrap">
            {row.assignee_email || row.assignee_login || row.assignee_name ? userLabel({
              name: row.assignee_name, email: row.assignee_email, github_login: row.assignee_login,
            }) : 'Unassigned'}
          </TableCell>
          {/* Words first, amber second: the count reads without the colour. */}
          <TableCell className="whitespace-nowrap text-stale">
            {row.days_silent} days
          </TableCell>
        </TableRow>
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
          {(data) => (
            <>
              <MilestoneCompletionTrend rows={data.sprints} />
              <MilestoneCompletionTable rows={data.sprints} />
            </>
          )}
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
