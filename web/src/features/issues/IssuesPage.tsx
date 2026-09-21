import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { useSession } from '../auth/useSession'
import { api, listAllWorkspaceIssues } from '../../lib/api'
import type { Issue, IssueStatus, Milestone, Project, User } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { StatusBadge, STATUS_LABELS } from '../../ui/StatusBadge'
import { IssueForm, type IssueInput } from '../work/CoreForms'

const ISSUE_STATUSES = Object.keys(STATUS_LABELS) as IssueStatus[]
const ISSUE_PRIORITIES = [0, 1, 2, 3, 4] as const
const controlClass = 'min-h-10 w-full border border-grey-300 bg-paper px-1 py-0.5 text-sm text-ink md:min-h-8'

function issueMatchesSearch(issue: Issue, search: string) {
  if (!search) return true
  return [issue.key, issue.title, issue.description]
    .some((value) => value.toLowerCase().includes(search))
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
  slug,
}: {
  issue: Issue
  members: Map<string, User>
  milestones: Map<string, string>
  slug: string
}) {
  const assignee = assigneeName(issue, members)
  const milestone = issue.milestone_id
    ? milestones.get(issue.milestone_id) ?? 'Milestone'
    : 'Unfiled'

  return (
    <li data-testid={`issue-row-${issue.id}`}>
      <NavLink
        to={`/w/${slug}/issues/${issue.key}`}
        className="block px-2 py-3 hover:bg-grey-100 focus-visible:bg-grey-100"
      >
        <div className="grid min-w-0 gap-2 md:grid-cols-[5rem_minmax(0,1fr)] md:items-center xl:grid-cols-[5rem_minmax(0,1fr)_8rem_4rem_12rem_14rem] xl:gap-x-4">
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
              aria-label={`Milestone: ${milestone}`}
              title={`Milestone: ${milestone}`}
              data-testid={`issue-milestone-${issue.id}`}
            >
              {milestone}
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
  const [status, setStatus] = useState<IssueStatus | ''>('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('')
  // The Projects page links here with ?project=<key>, so a project's open
  // count lands on exactly the issues it counted.
  const [project, setProject] = useState(
    () => new URLSearchParams(window.location.search).get('project') ?? '',
  )
  const [creatingIssue, setCreatingIssue] = useState(false)

  const issues = useQuery({
    queryKey: ['issues', slug],
    queryFn: () => listAllWorkspaceIssues(slug),
  })
  const members = useQuery({
    queryKey: ['members', slug],
    queryFn: async () => (await api.get<{ members: User[] }>(`/w/${slug}/members`)).members,
  })
  const milestones = useQuery({
    queryKey: ['milestones', slug, 'all'],
    queryFn: () => api.get<{ milestones: Milestone[] }>(`/w/${slug}/milestones`),
  })
  const projects = useQuery({
    queryKey: ['projects', slug, false],
    queryFn: () => api.get<{ projects: Project[] }>(`/w/${slug}/projects`),
  })
  const createIssue = useMutation({
    mutationFn: (input: IssueInput) => api.post<Issue>(`/w/${slug}/issues`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['issues', slug] }),
  })

  const allIssues = useMemo(() => issues.data ?? [], [issues.data])
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
    for (const issue of allIssues) {
      if (issue.assignee_id && !options.has(issue.assignee_id)) {
        options.set(issue.assignee_id, `Assigned member (${issue.assignee_id.slice(0, 8)})`)
      }
    }
    return [...options.entries()].sort(([, a], [, b]) => a.localeCompare(b))
  }, [allIssues, members.data])
  const projectsById = useMemo(
    () => new Map((projects.data?.projects ?? []).map((item) => [item.id, item])),
    [projects.data],
  )
  const filteredIssues = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return allIssues.filter((issue) => {
      if (!issueMatchesSearch(issue, normalizedSearch)) return false
      if (status && issue.status !== status) return false
      if (assignee === 'unassigned' && issue.assignee_id !== null) return false
      if (assignee && assignee !== 'unassigned' && issue.assignee_id !== assignee) return false
      if (priority && issue.priority !== Number(priority)) return false
      if (project === 'unfiled' && issue.project_id !== null) return false
      if (project && project !== 'unfiled') {
        if (!issue.project_id) return false
        if (projectsById.get(issue.project_id)?.key !== project) return false
      }
      return true
    })
  }, [allIssues, assignee, priority, project, projectsById, search, status])
  const hasFilters = Boolean(search.trim() || status || assignee || priority || project)

  function clearFilters() {
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
    <div className="w-full max-w-[80rem]" data-testid="issues-page">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg">Issues</h1>
        </div>
        {canWrite && !creatingIssue ? (
          <Button variant="primary" onClick={() => setCreatingIssue(true)}>New issue</Button>
        ) : null}
      </header>

      {creatingIssue ? (
        <section className="mb-4 border border-grey-200 p-3" aria-labelledby="new-issue-heading">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 id="new-issue-heading" className="text-base">New issue</h2>
              <p className="mt-1 text-sm text-grey-500">Add a piece of work to this workspace.</p>
            </div>
            <Button onClick={() => setCreatingIssue(false)}>Cancel</Button>
          </div>
          <IssueForm onSubmit={submitIssue} />
        </section>
      ) : null}

      <section className="border-y border-grey-200 py-2" aria-label="Issue filters">
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
              onChange={(event) => setStatus(event.target.value as IssueStatus | '')}
              data-testid="issues-status-filter"
            >
              <option value="">All statuses</option>
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
                <option key={item.id} value={item.key}>{item.name}</option>
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
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="all-issues-heading" className="text-xs tracking-wide text-grey-500 uppercase">All issues</h2>
          {!issues.isPending && !issues.error ? (
            <span className="text-sm text-grey-500" data-testid="issues-count">
              {hasFilters ? `${filteredIssues.length} of ${allIssues.length}` : allIssues.length} issues
            </span>
          ) : null}
        </div>

        {issues.isPending ? (
          <p className="text-sm text-grey-500" role="status" data-testid="issues-loading">Loading issues…</p>
        ) : issues.error ? (
          <div className="border border-grey-200 px-4 py-6" data-testid="issues-error">
            <p className="text-sm text-blocked" role="alert">Could not load issues.</p>
            <Button className="mt-3" onClick={() => void issues.refetch()}>Try again</Button>
          </div>
        ) : allIssues.length === 0 ? (
          <div data-testid="issues-empty">
            <EmptyState
              title="No issues yet"
              message={canWrite ? 'Create the first issue for this workspace.' : 'Ask a member to create the first issue.'}
              action={canWrite && !creatingIssue ? <Button onClick={() => setCreatingIssue(true)}>New issue</Button> : undefined}
            />
          </div>
        ) : filteredIssues.length === 0 ? (
          <div data-testid="issues-no-results">
            <EmptyState
              title="No matching issues"
              message="Try a different search or clear the filters."
              action={<Button onClick={clearFilters}>Clear filters</Button>}
            />
          </div>
        ) : (
          <ul
            className="divide-y divide-grey-200 border-y border-grey-200"
            data-testid="issues-list"
            aria-labelledby="all-issues-heading"
          >
            {filteredIssues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                members={membersById}
                milestones={milestonesById}
                slug={slug}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
