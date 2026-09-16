import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { useSession } from '../auth/useSession'
import { api, listAllWorkspaceIssues } from '../../lib/api'
import type { Issue, IssueStatus, User } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { StatusBadge, STATUS_LABELS } from '../../ui/StatusBadge'
import { IssueForm, type IssueInput } from '../work/CoreForms'

const ISSUE_STATUSES = Object.keys(STATUS_LABELS) as IssueStatus[]
const ISSUE_PRIORITIES = [0, 1, 2, 3, 4] as const
const controlClass = 'min-h-10 w-full rounded-[6px] border border-grey-300 bg-paper px-2 py-1.5 text-sm text-ink'

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

function IssueRow({ issue, members, slug }: { issue: Issue; members: Map<string, User>; slug: string }) {
  return (
    <li data-testid={`issue-row-${issue.id}`}>
      <NavLink
        to={`/w/${slug}/issues/${issue.key}`}
        className="block rounded-[8px] border border-grey-200 p-3 hover:bg-grey-100 focus-visible:bg-grey-100"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-grey-500">
          <span className="font-mono">{issue.key}</span>
          <StatusBadge status={issue.status} />
          <span aria-label={`Priority P${issue.priority}`}>P{issue.priority}</span>
        </div>
        <p className="mt-1 break-words text-sm font-medium text-ink">{issue.title}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-grey-500">
          <span>{issue.milestone_id ? 'Filed to milestone' : 'Unfiled'}</span>
          <span aria-hidden="true">·</span>
          <span>{assigneeName(issue, members)}</span>
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
  const [creatingIssue, setCreatingIssue] = useState(false)

  const issues = useQuery({
    queryKey: ['issues', slug],
    queryFn: () => listAllWorkspaceIssues(slug),
  })
  const members = useQuery({
    queryKey: ['members', slug],
    queryFn: async () => (await api.get<{ members: User[] }>(`/w/${slug}/members`)).members,
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
  const filteredIssues = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return allIssues.filter((issue) => {
      if (!issueMatchesSearch(issue, normalizedSearch)) return false
      if (status && issue.status !== status) return false
      if (assignee === 'unassigned' && issue.assignee_id !== null) return false
      if (assignee && assignee !== 'unassigned' && issue.assignee_id !== assignee) return false
      if (priority && issue.priority !== Number(priority)) return false
      return true
    })
  }, [allIssues, assignee, priority, search, status])
  const hasFilters = Boolean(search.trim() || status || assignee || priority)

  function clearFilters() {
    setSearch('')
    setStatus('')
    setAssignee('')
    setPriority('')
  }

  async function submitIssue(input: IssueInput) {
    await createIssue.mutateAsync(input)
    clearFilters()
    setCreatingIssue(false)
  }

  return (
    <div className="mx-auto w-full max-w-[80rem]" data-testid="issues-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-grey-500 uppercase">Workspace</p>
          <h1 className="mt-1 text-lg">Issues</h1>
          <p className="mt-1 max-w-prose text-sm text-grey-500">
            Every issue in {workspace?.workspace_name ?? 'this workspace'}, including unfiled work.
          </p>
        </div>
        {canWrite && !creatingIssue ? (
          <Button variant="primary" onClick={() => setCreatingIssue(true)}>New issue</Button>
        ) : null}
      </header>

      {creatingIssue ? (
        <section className="mt-5 border border-grey-200 p-3" aria-labelledby="new-issue-heading">
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

      <section className="mt-6 border-y border-grey-200 py-3" aria-label="Issue filters">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
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

      <section className="mt-6" aria-labelledby="all-issues-heading">
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
          <ul className="space-y-2" data-testid="issues-list">
            {filteredIssues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} members={membersById} slug={slug} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
