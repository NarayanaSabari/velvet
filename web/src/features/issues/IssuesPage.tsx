import { FormDialog } from '../../ui/FormDialog'
import { ErrorNote } from '../../ui/ErrorNote'
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Heading } from '@astryxdesign/core/Heading'
import { List, ListItem } from '@astryxdesign/core/List'
import { Pagination } from '@astryxdesign/core/Pagination'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'

import { useSession } from '../auth/useSession'
import { api } from '../../lib/api'
import { priorityOption } from '../../lib/priority'
import type { Issue, IssueStatus, Milestone, Project, User } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { SelectField, TextField } from '../../ui/fields'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { StatusBadge, STATUS_LABELS } from '../../ui/StatusBadge'
import { RelativeTime } from '../../ui/RelativeTime'
import { IssueForm, type IssueInput } from '../work/CoreForms'
import { membersQuery, projectsQuery, useWorkLinks } from '../work/workLinks'

const ISSUE_STATUSES = Object.keys(STATUS_LABELS) as IssueStatus[]
/** `open` is every unfinished status and is the view the page opens on.
 *  `all` adds done and cancelled work back. */
type StatusFilter = IssueStatus | 'open' | 'all'
const DEFAULT_STATUS: StatusFilter = 'open'
const ISSUE_PRIORITIES = [0, 1, 2, 3, 4] as const

const FILTER_KEYS = { search: 'q', status: 'status', assignee: 'assignee', priority: 'priority', project: 'project' } as const
type Filters = { search: string; status: StatusFilter; assignee: string; priority: string; project: string }

function readFilters(): Filters {
  const query = new URLSearchParams(window.location.search)
  const status = query.get('status') ?? ''
  const priority = query.get('priority') ?? ''
  return {
    search: query.get('q') ?? '',
    status: status === 'all' || (ISSUE_STATUSES as readonly string[]).includes(status) ? (status as StatusFilter) : DEFAULT_STATUS,
    assignee: query.get('assignee') ?? '',
    priority: (ISSUE_PRIORITIES as readonly number[]).map(String).includes(priority) ? priority : '',
    project: query.get('project') ?? '',
  }
}

function writeFilters(filters: Filters) {
  const url = new URL(window.location.href)
  for (const [field, key] of Object.entries(FILTER_KEYS)) {
    const value = filters[field as keyof Filters]
    if (field === 'status' && value === DEFAULT_STATUS) {
      // The default needs no parameter, but a link that names it outright,
      // such as a project's open count, keeps the address it arrived with.
      if (url.searchParams.get(key) !== DEFAULT_STATUS) url.searchParams.delete(key)
    } else if (value) url.searchParams.set(key, value)
    else url.searchParams.delete(key)
  }
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url)
}

function assigneeName(issue: Issue, members: Map<string, User>) {
  if (!issue.assignee_id) return 'Unassigned'
  return members.get(issue.assignee_id)
    ? userLabel(members.get(issue.assignee_id))
    : `Assigned member (${issue.assignee_id.slice(0, 8)})`
}

function IssueRow({
  issue,
  members,
  milestones,
  projects,
  slug,
  underStatusHeading = false,
}: {
  issue: Issue
  members: Map<string, User>
  milestones: Map<string, string>
  projects: Map<string, Project>
  slug: string
  /** The row sits under a heading that already names its status, so the
   *  badge is dropped and its column goes to the title. */
  underStatusHeading?: boolean
}) {
  const assignee = assigneeName(issue, members)
  const milestone = issue.milestone_id
    ? milestones.get(issue.milestone_id) ?? 'Milestone'
    : 'Unfiled'
  const project = issue.project_id ? projects.get(issue.project_id) : undefined

  // Astryx's list row is the link, with its hover, focus and divider. The
  // columns inside are Velvet's grid, so every row lines up with the next.
  // Each row is its own grid, so every xl column has a set width to keep rows aligned.
  // Labels sit beside the title and dates never wrap, so a row is one line unless its
  // title is long. The milestone column widens when the page has room for full names.
  const columns = (
    <div
      className={`grid min-w-0 gap-2 md:grid-cols-[5rem_minmax(0,1fr)] md:items-center xl:gap-x-4 xl:gap-y-0 ${
        underStatusHeading
          ? 'xl:grid-cols-[5rem_minmax(16rem,1fr)_3rem_7.5rem_minmax(11rem,15rem)_6.5rem]'
          : 'xl:grid-cols-[5rem_minmax(16rem,1fr)_7rem_3rem_7.5rem_minmax(11rem,15rem)_6.5rem]'
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 md:contents">
        <span className="shrink-0 font-mono text-xs text-grey-500" data-testid={`issue-key-${issue.id}`}>
          {issue.key}
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="min-w-0 break-words text-sm font-medium text-ink" data-testid={`issue-title-${issue.id}`}>
            {issue.title}
          </span>
          <span
            className="flex min-w-0 flex-wrap gap-1 text-xs empty:hidden"
            aria-label={issue.labels?.length ? `Labels: ${issue.labels.map((label) => label.name).join(', ')}` : undefined}
            data-testid={`issue-labels-${issue.id}`}
          >
            {issue.labels?.map((label) => <Token key={label.id} label={label.name} size="sm" />)}
          </span>
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-grey-500 md:col-span-2 xl:contents">
        {underStatusHeading ? (
          // Still part of the row's name for assistive technology.
          <span className="sr-only" data-testid={`issue-status-${issue.id}`}>
            {STATUS_LABELS[issue.status]}
          </span>
        ) : (
          <span className="min-w-0" data-testid={`issue-status-${issue.id}`}>
            <StatusBadge status={issue.status} />
          </span>
        )}
        <span className="shrink-0" aria-label={`Priority P${issue.priority}`} data-testid={`issue-priority-${issue.id}`}>
          P{issue.priority}
        </span>
        {/* A person's name reads a step stronger than "Unassigned", so a
            column of names shows its gaps at a glance. The word stays,
            so the difference is never colour alone. */}
        <span
          className={`min-w-0 max-w-full truncate ${issue.assignee_id ? 'text-grey-700' : ''}`}
          aria-label={`Assignee: ${assignee}`}
          title={`Assignee: ${assignee}`}
          data-testid={`issue-assignee-${issue.id}`}
        >
          {assignee}
        </span>
        <span
          className="min-w-0 max-w-full truncate"
          aria-label={project ? `Project: ${project.name}, milestone: ${milestone}` : `Milestone: ${milestone}`}
          title={project ? `${project.name} · ${milestone}` : `Milestone: ${milestone}`}
          data-testid={`issue-milestone-${issue.id}`}
        >
          {project ? <span className="text-grey-700">{project.key} · </span> : null}
          {milestone}
        </span>
        <span className="shrink-0 whitespace-nowrap" data-testid={`issue-updated-${issue.id}`}>
          <RelativeTime iso={issue.updated_at} />
        </span>
      </div>
    </div>
  )

  return (
    <ListItem
      itemKey={issue.id}
      data-testid={`issue-row-${issue.id}`}
      href={`/w/${slug}/issues/${issue.key}`}
      label={columns}
    />
  )
}

export function IssuesPage({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'
  // Filters live in the URL so reload and shared links keep them. The
  // Projects page links here with ?project=<key>&status=open.
  const [initial] = useState(readFilters)
  const [search, setSearch] = useState(initial.search)
  const [status, setStatus] = useState<StatusFilter>(initial.status)
  const [assignee, setAssignee] = useState(initial.assignee)
  const [priority, setPriority] = useState(initial.priority)
  const [project, setProject] = useState(initial.project)
  useEffect(() => {
    writeFilters({ search, status, assignee, priority, project })
  }, [search, status, assignee, priority, project])
  const [creatingIssue, setCreatingIssue] = useState(false)

  // The server orders by status before position, so the status groups below
  // stay in workflow order across pages instead of being regrouped per page.
  const params = new URLSearchParams({ limit: '50', include_counts: 'true', fields: 'summary', group: 'status' })
  if (search.trim()) params.set('q', search.trim())
  if (status === 'open') {
    for (const value of ISSUE_STATUSES) if (value !== 'done' && value !== 'cancelled') params.append('status', value)
  } else if (status !== 'all') params.set('status', status)
  if (assignee === 'unassigned') params.set('unassigned', 'true')
  else if (assignee) params.set('assignee_id', assignee)
  if (priority) params.set('priority', priority)
  if (project === 'unfiled') params.set('unfiled', 'true')
  else if (project) params.set('project', project)
  const filterKey = `${slug}?${params}`
  const [pagination, setPagination] = useState({ filterKey, cursors: [''] })
  if (pagination.filterKey !== filterKey) setPagination({ filterKey, cursors: [''] })
  // A new filter always starts at page one, without fetching an old cursor first.
  const cursors = pagination.filterKey === filterKey ? pagination.cursors : ['']
  const cursor = cursors[cursors.length - 1]
  if (cursor) params.set('cursor', cursor)
  const issues = useQuery({
    queryKey: ['issues', slug, params.toString()],
    queryFn: () => api.get<{ issues: Issue[]; next_cursor: string; matched_count: number; total_count: number; assignee_ids: string[] }>(`/w/${slug}/issues?${params}`),
  })
  const members = useQuery({
    ...membersQuery(slug),
    select: (data) => data.members,
  })
  const milestones = useQuery({
    queryKey: ['milestones', slug, 'all'],
    queryFn: () => api.get<{ milestones: Milestone[] }>(`/w/${slug}/milestones`),
  })
  const projects = useQuery(projectsQuery(slug))
  const createIssue = useMutation({
    mutationFn: (input: IssueInput) => api.post<Issue>(`/w/${slug}/issues`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['issues', slug] }),
  })
  const links = useWorkLinks(slug)

  const allIssues = useMemo(() => issues.data?.issues ?? [], [issues.data])
  const membersById = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.id, member])),
    [members.data],
  )
  const milestonesById = useMemo(
    () => new Map((milestones.data?.milestones ?? []).map((milestone) => [milestone.id, milestone.name])),
    [milestones.data],
  )
  const assigneeOptions = useMemo(() => {
    const options = new Map<string, string>()
    for (const member of members.data ?? []) options.set(member.id, userLabel(member))
    for (const id of issues.data?.assignee_ids ?? []) {
      if (!options.has(id)) options.set(id, `Assigned member (${id.slice(0, 8)})`)
    }
    for (const issue of allIssues) {
      if (issue.assignee_id && !options.has(issue.assignee_id)) {
        options.set(issue.assignee_id, `Assigned member (${issue.assignee_id.slice(0, 8)})`)
      }
    }
    if (assignee && assignee !== 'unassigned' && !options.has(assignee)) {
      options.set(assignee, `Assigned member (${assignee.slice(0, 8)})`)
    }
    return [...options.entries()].sort(([, a], [, b]) => a.localeCompare(b))
  }, [allIssues, issues.data?.assignee_ids, members.data, assignee])
  // Rows arrive ordered by status, so a group is each run of one status.
  const statusGroups = useMemo(() => {
    const groups: { status: IssueStatus; issues: Issue[] }[] = []
    for (const issue of allIssues) {
      const last = groups[groups.length - 1]
      if (last && last.status === issue.status) last.issues.push(issue)
      else groups.push({ status: issue.status, issues: [issue] })
    }
    return groups
  }, [allIssues])
  // A single chosen status needs no heading repeating it.
  const showGroupHeadings = status === 'open' || status === 'all'
  // A count is only true when every matching issue is on this one page.
  const wholeResultShown = cursors.length === 1 && !issues.data?.next_cursor
  const hasFilters = Boolean(search.trim() || status !== DEFAULT_STATUS || assignee || priority || project)
  // The open view hides finished work, so the count says "24 of 30" whenever
  // the list is shorter than the organisation's total, filtered or not.
  const narrowed = hasFilters || (issues.data !== undefined && issues.data.matched_count !== issues.data.total_count)
  // Nothing is filtered, yet nothing shows: every issue is done or cancelled.
  const allFinished = !hasFilters && !cursor

  function clearFilters() {
    setPagination({ filterKey: '', cursors: [''] })
    setSearch('')
    setStatus(DEFAULT_STATUS)
    setAssignee('')
    setPriority('')
    setProject('')
  }

  async function submitIssue(input: IssueInput) {
    await createIssue.mutateAsync(input)
    clearFilters()
    setCreatingIssue(false)
  }

  return (
    <div className="w-full min-w-0" data-testid="issues-page">
      <PageHeader
        title="Issues"
        description="Search, triage, and move the concrete work that belongs to this organisation."
        actions={canWrite ? (
          <Button variant="primary" onClick={() => setCreatingIssue(true)}>New issue</Button>
        ) : undefined}
      />

      {creatingIssue ? (
        <FormDialog title="New issue" description="Add a piece of work to this workspace." onClose={() => setCreatingIssue(false)}>
          <IssueForm
            links={{
              projects: links.projects,
              milestones: links.milestones,
              // Filtering to a project and then pressing New issue means
              // "a new issue here", so the filter becomes the default.
              defaultProjectId: links.projects.find((item) => item.key === project)?.id,
            }}
            onSubmit={submitIssue}
          />
        </FormDialog>
      ) : null}

      {/* No panel: the filters sit on the page so the list below is the heaviest thing on it. */}
      <section aria-label="Issue filters">
        <div className="grid items-end gap-2 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto]">
          <TextField
            label="Search"
            aria-label="Search issues"
            type="search"
            value={search}
            placeholder="Key, title, or description"
            onChange={setSearch}
            data-testid="issues-search"
          />
          <SelectField
            label="Status"
            aria-label="Filter by status"
            value={status}
            onChange={(value) => setStatus(value as StatusFilter)}
            data-testid="issues-status-filter"
            options={[
              { value: 'open', label: 'Open statuses' },
              { value: 'all', label: 'All statuses' },
              ...ISSUE_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
            ]}
          />
          <SelectField
            label="Assignee"
            aria-label="Filter by assignee"
            value={assignee}
            onChange={setAssignee}
            data-testid="issues-assignee-filter"
            options={[
              { value: '', label: 'All assignees' },
              { value: 'unassigned', label: 'Unassigned' },
              ...assigneeOptions.map(([id, label]) => ({ value: id, label })),
            ]}
          />
          <SelectField
            label="Project"
            aria-label="Filter by project"
            value={project}
            onChange={setProject}
            data-testid="issues-project-filter"
            options={[
              { value: '', label: 'All projects' },
              { value: 'unfiled', label: 'Unfiled' },
              ...(projects.data?.projects ?? []).map((item) => ({
                value: item.key,
                label: `${item.name}${item.status === 'archived' ? ' (archived)' : ''}`,
              })),
            ]}
          />
          <SelectField
            label="Priority"
            aria-label="Filter by priority"
            value={priority}
            onChange={setPriority}
            data-testid="issues-priority-filter"
            options={[
              { value: '', label: 'All priorities' },
              ...ISSUE_PRIORITIES.map((value) => ({ value: String(value), label: priorityOption(value) })),
            ]}
          />
          {/* Only offered when there is something to clear, so the resting
              toolbar is five controls and nothing else. */}
          {hasFilters ? (
            <Button
              className="self-end whitespace-nowrap"
              variant="ghost"
              onClick={clearFilters}
              data-testid="issues-clear-filters"
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </section>

      <section className="mt-4" aria-labelledby="all-issues-heading">
        <SectionHeader
          id="all-issues-heading"
          title={status === 'open' ? 'Open issues' : 'All issues'}
          meta={!issues.isPending && !issues.error ? (
            <span data-testid="issues-count">
              {narrowed ? `${issues.data?.matched_count} of ${issues.data?.total_count}` : issues.data?.total_count} issues
            </span>
          ) : undefined}
        />

        {issues.isPending ? (
          <p className="text-sm text-grey-500" role="status" data-testid="issues-loading">Loading issues…</p>
        ) : issues.error ? (
          <div className="border border-grey-200 px-4 py-6" data-testid="issues-error">
            <ErrorNote>Could not load issues.</ErrorNote>
            <Button className="mt-3" onClick={() => void issues.refetch()}>Try again</Button>
          </div>
        ) : issues.data?.total_count === 0 ? (
          <div data-testid="issues-empty">
            <EmptyState
              title="No issues yet"
              message={canWrite ? 'Create the first issue for this workspace.' : 'Ask a member to create the first issue.'}
              action={canWrite ? <Button onClick={() => setCreatingIssue(true)}>New issue</Button> : undefined}
            />
          </div>
        ) : allIssues.length === 0 ? (
          <div data-testid="issues-no-results">
            {allFinished ? (
              <EmptyState
                title="No open issues"
                message="Everything here is done or cancelled."
                action={<Button onClick={() => setStatus('all')}>Show all issues</Button>}
              />
            ) : (
              <EmptyState
                title={cursor && issues.data?.matched_count ? 'No issues on this page' : 'No matching issues'}
                message={cursor && issues.data?.matched_count ? 'Issues changed since you opened this page. Go back to the previous page.' : 'Try a different search or clear the filters.'}
                action={cursor ? <Button onClick={() => setPagination({ filterKey, cursors: [''] })}>First page</Button> : <Button onClick={clearFilters}>Clear filters</Button>}
              />
            )}
          </div>
        ) : (
          // The section heading's rule is the top edge, so this draws only
          // the dividers between groups and its bottom edge.
          <div className="divide-y divide-grey-200 border-b border-grey-200" data-testid="issues-list">
            {statusGroups.map((group) => {
              const label = STATUS_LABELS[group.status]
              return (
                // Keyed by its first issue: a server that predates status
                // ordering can return one status as several separate runs.
                <div key={group.issues[0]?.id ?? group.status} data-testid={`issue-group-${group.status}`}>
                  <List
                    hasDividers
                    density="balanced"
                    edge="flush"
                    aria-label={showGroupHeadings ? undefined : `${label} issues`}
                    header={showGroupHeadings ? (
                      <div className="flex items-baseline gap-2 px-2 pt-5 pb-2">
                        <Heading level={3}>{label}</Heading>
                        {wholeResultShown ? (
                          <Text type="supporting" color="secondary" aria-label={`${group.issues.length} ${label.toLowerCase()} issues`}>
                            {group.issues.length}
                          </Text>
                        ) : null}
                      </div>
                    ) : undefined}
                  >
                    {group.issues.map((issue) => (
                      <IssueRow
                        key={issue.id}
                        issue={issue}
                        members={membersById}
                        milestones={milestonesById}
                        projects={links.projectById}
                        slug={slug}
                        underStatusHeading={showGroupHeadings}
                      />
                    ))}
                  </List>
                </div>
              )
            })}
          </div>
        )}
        {cursors.length > 1 || issues.data?.next_cursor ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {/* The API pages by cursor, so there is a next and a previous but
                no page count to jump within. */}
            <Pagination
              label="Issue pagination"
              variant="compact"
              page={cursors.length}
              hasMore={Boolean(issues.data?.next_cursor) && !issues.error}
              isDisabled={issues.isFetching}
              onChange={(page) => {
                if (page > cursors.length && issues.data?.next_cursor) {
                  setPagination({ filterKey, cursors: [...cursors, issues.data.next_cursor] })
                } else if (page < cursors.length && cursors.length > 1) {
                  setPagination({ filterKey, cursors: cursors.slice(0, -1) })
                }
              }}
            />
            <Text role="status">Page {cursors.length}</Text>
          </div>
        ) : null}
      </section>
    </div>
  )
}
