import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { useSession } from '../auth/useSession'
import { api } from '../../lib/api'
import type { Issue, IssueStatus, Milestone, Project, User } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { StatusBadge, STATUS_LABELS } from '../../ui/StatusBadge'
import { RelativeTime } from '../../ui/RelativeTime'
import { IssueForm, type IssueInput } from '../work/CoreForms'
import { membersQuery, projectsQuery, useWorkLinks } from '../work/workLinks'

const ISSUE_STATUSES = Object.keys(STATUS_LABELS) as IssueStatus[]
type StatusFilter = IssueStatus | 'open' | ''
const ISSUE_PRIORITIES = [0, 1, 2, 3, 4] as const
const controlClass = 'ui-control min-h-10 w-full px-2 py-1 text-sm leading-5 md:min-h-8'

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
}: {
  issue: Issue
  members: Map<string, User>
  milestones: Map<string, string>
  projects: Map<string, Project>
  slug: string
}) {
  const assignee = assigneeName(issue, members)
  const milestone = issue.milestone_id
    ? milestones.get(issue.milestone_id) ?? 'Milestone'
    : 'Unfiled'
  const project = issue.project_id ? projects.get(issue.project_id) : undefined

  return (
    <li data-testid={`issue-row-${issue.id}`}>
      <NavLink
        to={`/w/${slug}/issues/${issue.key}`}
        className="block px-2 py-3 hover:bg-grey-100 focus-visible:bg-grey-100"
      >
        <div className="grid min-w-0 gap-2 md:grid-cols-[5rem_minmax(0,1fr)] md:items-center xl:grid-cols-[5rem_minmax(0,1fr)_8rem_3rem_11rem_12rem_minmax(0,10rem)_5rem] xl:gap-x-4">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 md:contents">
            <span className="shrink-0 font-mono text-xs text-grey-500" data-testid={`issue-key-${issue.id}`}>
              {issue.key}
            </span>
            <span className="min-w-0 break-words text-sm font-medium text-ink" data-testid={`issue-title-${issue.id}`}>
              {issue.title}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-grey-500 md:col-span-2 xl:contents">
            <span className="min-w-0" data-testid={`issue-status-${issue.id}`}>
              <StatusBadge status={issue.status} />
            </span>
            <span className="shrink-0" aria-label={`Priority P${issue.priority}`} data-testid={`issue-priority-${issue.id}`}>
              P{issue.priority}
            </span>
            <span
              className="min-w-0 max-w-full truncate"
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
            <span
              className="flex min-w-0 flex-wrap gap-1"
              aria-label={issue.labels?.length ? `Labels: ${issue.labels.map((label) => label.name).join(', ')}` : undefined}
              data-testid={`issue-labels-${issue.id}`}
            >
              {issue.labels?.map((label) => (
                <span key={label.id} className="border border-grey-200 px-1 leading-4 text-grey-700">
                  {label.name}
                </span>
              ))}
            </span>
            <span className="shrink-0" data-testid={`issue-updated-${issue.id}`}>
              <RelativeTime iso={issue.updated_at} />
            </span>
          </div>
        </div>
      </NavLink>
    </li>
  )
}

export function IssuesPage({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>(() => new URLSearchParams(window.location.search).get('status') === 'open' ? 'open' : '')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('')
  // The Projects page links here with ?project=<key>, so a project's open
  // count lands on exactly the issues it counted.
  const [project, setProject] = useState(
    () => new URLSearchParams(window.location.search).get('project') ?? '',
  )
  const [creatingIssue, setCreatingIssue] = useState(false)

  const params = new URLSearchParams({ limit: '50', include_counts: 'true', fields: 'summary' })
  if (search.trim()) params.set('q', search.trim())
  if (status === 'open') {
    for (const value of ISSUE_STATUSES) if (value !== 'done' && value !== 'cancelled') params.append('status', value)
  } else if (status) params.set('status', status)
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
  const hasFilters = Boolean(search.trim() || status || assignee || priority || project)

  function clearFilters() {
    setPagination({ filterKey: '', cursors: [''] })
    setSearch('')
    setStatus('')
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
        actions={canWrite && !creatingIssue ? (
          <Button variant="primary" onClick={() => setCreatingIssue(true)}>New issue</Button>
        ) : undefined}
      />

      {creatingIssue ? (
        <section className="ui-surface mb-6 p-4" aria-labelledby="new-issue-heading">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 id="new-issue-heading" className="text-base">New issue</h2>
              <p className="mt-1 text-sm text-grey-500">Add a piece of work to this workspace.</p>
            </div>
            <Button onClick={() => setCreatingIssue(false)}>Cancel</Button>
          </div>
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
        </section>
      ) : null}

      <section className="ui-surface bg-grey-100 p-3" aria-label="Issue filters">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto]">
          <label className="block min-w-0 text-sm">
            <span className="mb-1 block text-grey-500">Search issues</span>
            <input
              className={controlClass}
              type="search"
              value={search}
              placeholder="Key, title, or description"
              onChange={(event) => setSearch(event.target.value)}
              data-testid="issues-search"
            />
          </label>
          <label className="block min-w-0 text-sm">
            <span className="mb-1 block text-grey-500">Filter by status</span>
            <select
              className={controlClass}
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
              data-testid="issues-status-filter"
            >
              <option value="">All statuses</option>
              <option value="open">Open statuses</option>
              {ISSUE_STATUSES.map((value) => (
                <option key={value} value={value}>{STATUS_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <label className="block min-w-0 text-sm">
            <span className="mb-1 block text-grey-500">Filter by assignee</span>
            <select
              className={controlClass}
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              data-testid="issues-assignee-filter"
            >
              <option value="">All assignees</option>
              <option value="unassigned">Unassigned</option>
              {assigneeOptions.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>
          <label className="block min-w-0 text-sm">
            <span className="mb-1 block text-grey-500">Filter by project</span>
            <select
              className={controlClass}
              value={project}
              onChange={(event) => setProject(event.target.value)}
              data-testid="issues-project-filter"
            >
              <option value="">All projects</option>
              <option value="unfiled">Unfiled</option>
              {(projects.data?.projects ?? []).map((item) => (
                <option key={item.id} value={item.key}>{item.name}{item.status === 'archived' ? ' (archived)' : ''}</option>
              ))}
            </select>
          </label>
          <label className="block min-w-0 text-sm">
            <span className="mb-1 block text-grey-500">Filter by priority</span>
            <select
              className={controlClass}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              data-testid="issues-priority-filter"
            >
              <option value="">All priorities</option>
              {ISSUE_PRIORITIES.map((value) => (
                <option key={value} value={value}>P{value}</option>
              ))}
            </select>
          </label>
          <Button
            className="self-end whitespace-nowrap"
            variant="ghost"
            disabled={!hasFilters}
            onClick={clearFilters}
            data-testid="issues-clear-filters"
          >
            Clear filters
          </Button>
        </div>
      </section>

      <section className="mt-4" aria-labelledby="all-issues-heading">
        <SectionHeader
          id="all-issues-heading"
          title="All issues"
          meta={!issues.isPending && !issues.error ? (
            <span data-testid="issues-count">
              {hasFilters ? `${issues.data?.matched_count} of ${issues.data?.total_count}` : issues.data?.total_count} issues
            </span>
          ) : undefined}
        />

        {issues.isPending ? (
          <p className="text-sm text-grey-500" role="status" data-testid="issues-loading">Loading issues…</p>
        ) : issues.error ? (
          <div className="border border-grey-200 px-4 py-6" data-testid="issues-error">
            <p className="text-sm text-blocked" role="alert">Could not load issues.</p>
            <Button className="mt-3" onClick={() => void issues.refetch()}>Try again</Button>
          </div>
        ) : issues.data?.total_count === 0 ? (
          <div data-testid="issues-empty">
            <EmptyState
              title="No issues yet"
              message={canWrite ? 'Create the first issue for this workspace.' : 'Ask a member to create the first issue.'}
              action={canWrite && !creatingIssue ? <Button onClick={() => setCreatingIssue(true)}>New issue</Button> : undefined}
            />
          </div>
        ) : allIssues.length === 0 ? (
          <div data-testid="issues-no-results">
            <EmptyState
              title={cursor && issues.data?.matched_count ? 'No issues on this page' : 'No matching issues'}
              message={cursor && issues.data?.matched_count ? 'Issues changed since you opened this page. Go back to the previous page.' : 'Try a different search or clear the filters.'}
              action={cursor ? <Button onClick={() => setPagination({ filterKey, cursors: [''] })}>First page</Button> : <Button onClick={clearFilters}>Clear filters</Button>}
            />
          </div>
        ) : (
          <ul
            className="divide-y divide-grey-200 border-y border-grey-200"
            data-testid="issues-list"
            aria-labelledby="all-issues-heading"
          >
            {allIssues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                members={membersById}
                milestones={milestonesById}
                projects={links.projectById}
                slug={slug}
              />
            ))}
          </ul>
        )}
        {cursors.length > 1 || issues.data?.next_cursor ? (
          <nav className="mt-4 flex flex-wrap items-center gap-3" aria-label="Issue pagination">
            <Button disabled={cursors.length === 1 || issues.isFetching} onClick={() => setPagination({ filterKey, cursors: cursors.slice(0, -1) })}>Previous page</Button>
            <span className="text-sm" role="status">Page {cursors.length}</span>
            <Button disabled={!issues.data?.next_cursor || issues.isFetching || Boolean(issues.error)} onClick={() => {
              if (issues.data?.next_cursor) setPagination({ filterKey, cursors: [...cursors, issues.data.next_cursor] })
            }}>Next page</Button>
          </nav>
        ) : null}
      </section>
    </div>
  )
}
