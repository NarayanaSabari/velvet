import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, isNotFound } from '../../lib/api'
import type {
  Activity,
  Comment,
  Evidence,
  Issue,
  IssueStatus,
  Label,
  Milestone,
  User,
} from '../../lib/types'
import { Avatar } from '../../ui/Avatar'
import { Markdown } from '../../ui/Markdown'
import { RelativeTime } from '../../ui/RelativeTime'
import { StatusBadge, STATUS_LABELS } from '../../ui/StatusBadge'
import { EmptyState } from '../../ui/EmptyState'
import { CommentComposer } from '../comments/CommentComposer'
import { ReplyEditor } from '../comments/CommentThread'
import { EvidenceCard } from '../evidence/EvidenceCard'
import { StatusDot, StatusSelect } from './StatusSelect'
import { IssueLabels } from './IssueLabels'
import { IssueMetadata, ReadOnlyIssueMetadata, type IssueMetadataPatch } from './IssueMetadata'
import { useSession } from '../auth/useSession'
import { userLabel } from '../../lib/userLabel'
import { IssueEditForm, IssueForm, type IssueInput } from '../work/CoreForms'
import { Button } from '../../ui/Button'
import { ErrorState, LoadingState, NotFoundState } from '../../ui/QueryState'
import { NavLink } from '../../app/nav'

export type TimelineEntry =
  | { kind: 'comment'; id: string; at: string; body: string; author: User | null; parentId?: string | null }
  | { kind: 'status'; id: string; at: string; from: string | null; to: string | null }
  | { kind: 'pr'; id: string; at: string; number: number; state: string }
  | { kind: 'commit'; id: string; at: string; message: string; author: string }
  | { kind: 'review'; id: string; at: string; reviewer: string; state: string }
  | { kind: 'event'; id: string; at: string; text: string }

function label(status: string | null): string {
  if (!status) return 'unknown'
  return STATUS_LABELS[status as IssueStatus] ?? status
}

/**
 * One unified log of everything that happened to an issue. Comments, status
 * changes, commits, PRs, and reviews are one narrative, because reading them
 * separately loses the order in which the work actually happened.
 */
export function IssueTimeline({ entries, onReply }: {
  entries: TimelineEntry[]
  onReply?: (commentId: string, body: string) => Promise<unknown>
}) {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at))

  if (sorted.length === 0) {
    return <EmptyState title="No updates yet." message="Add the first update below." />
  }

  return (
    <ul className="divide-y divide-grey-200 border-y border-grey-200">
      {sorted.map((entry) => (
        <li key={`${entry.kind}-${entry.id}`} className="py-2 text-sm">
          <div className="flex items-baseline gap-2">
            <div className="min-w-0 flex-1">
              {entry.kind === 'comment' ? (
                <>
                  <span className="text-ink">
                    {userLabel(entry.author)}
                  </span>
                  <div className="mt-0.5 flex gap-2">
                    <Avatar user={entry.author} />
                    <Markdown source={entry.body} />
                  </div>
                </>
              ) : entry.kind === 'status' ? (
                <span className="text-grey-700">
                  Status {label(entry.from)} → {label(entry.to)}
                </span>
              ) : entry.kind === 'pr' ? (
                <span className="text-grey-700">
                  PR <span className="text-ink">#{entry.number}</span> {entry.state}
                </span>
              ) : entry.kind === 'commit' ? (
                <span className="text-grey-700">
                  {entry.author} pushed {entry.message}
                </span>
              ) : entry.kind === 'review' ? (
                <span className="text-grey-700">
                  {entry.reviewer} reviewed: {entry.state}
                </span>
              ) : (
                <span className="text-grey-700">{entry.text}</span>
              )}
            </div>
            <RelativeTime iso={entry.at} />
          </div>
          {entry.kind === 'comment' && !entry.parentId && onReply ? (
            <ReplyEditor commentId={entry.id} onReply={onReply} />
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function buildTimeline(
  comments: Comment[],
  activity: Activity[],
  evidence: Evidence | undefined,
): TimelineEntry[] {
  const entries: TimelineEntry[] = comments.flatMap((comment) =>
    [comment, ...(comment.replies ?? [])].map((c) => ({
      kind: 'comment' as const,
      id: c.id,
      at: c.created_at,
      body: c.deleted_at ? '_Comment deleted_' : c.body,
      author: c.author ?? null,
      parentId: c.parent_id,
    })),
  )

  for (const a of activity) {
    if (a.verb !== 'changed_status') continue
    entries.push({
      kind: 'status',
      id: String(a.id),
      at: a.created_at,
      from: typeof a.metadata.from === 'string' ? a.metadata.from : null,
      to: typeof a.metadata.to === 'string' ? a.metadata.to : null,
    })
  }

  for (const pr of evidence?.pull_requests ?? []) {
    entries.push({
      kind: 'pr',
      id: pr.id,
      at: pr.merged_at ?? pr.gh_created_at ?? pr.gh_updated_at ?? '',
      number: pr.number,
      state: pr.merged_at ? 'merged' : pr.state,
    })
  }
  for (const commit of evidence?.commits ?? []) {
    entries.push({
      kind: 'commit',
      id: commit.sha,
      at: commit.committed_at,
      message: commit.message.split('\n')[0] ?? '',
      author: commit.author_login,
    })
  }
  for (const review of evidence?.reviews ?? []) {
    entries.push({
      kind: 'review',
      id: review.id,
      at: review.submitted_at,
      reviewer: review.reviewer_login,
      state: review.state,
    })
  }

  return entries
}

export function IssuePageLayout({ main, sidebar }: { main: ReactNode; sidebar: ReactNode }) {
  return (
    <div className="w-full max-w-[80rem]" data-testid="issue-page">
      <div
        className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]"
        data-testid="issue-page-columns"
      >
        <div className="min-w-0" data-testid="issue-main">
          {main}
        </div>
        <aside className="min-w-0 lg:sticky lg:top-4" data-testid="issue-sidebar">
          {sidebar}
        </aside>
      </div>
    </div>
  )
}

export function IssueEvidenceSection({
  evidence,
  issueStatus,
  isPending = false,
  hasError = false,
}: {
  evidence?: Evidence
  issueStatus: IssueStatus
  isPending?: boolean
  hasError?: boolean
}) {
  const pullRequests = evidence?.pull_requests ?? []

  return (
    <section className="border-t border-grey-200 pt-4" data-testid="issue-evidence-section">
      <h2 className="mb-2 text-xs tracking-wide text-grey-500 uppercase">Linked PRs / evidence</h2>
      {isPending ? (
        <LoadingState label="Loading linked PRs…" />
      ) : hasError ? (
        <p className="text-sm text-blocked" role="alert">Could not load linked PRs.</p>
      ) : pullRequests.length === 0 ? (
        <div data-testid="issue-evidence-empty">
          <EmptyState
            title="No linked PRs."
            message="Branch as sabari/eng-42-... to link automatically."
          />
        </div>
      ) : (
        <div className="space-y-1">
          {/* PRs are evidence only. Status changes stay in the status control
              above and are never triggered by this section. */}
          {pullRequests.map((pr) => (
            <EvidenceCard key={pr.id} pr={pr} issueStatus={issueStatus} />
          ))}
        </div>
      )}
    </section>
  )
}

export function IssuePage({ slug, issueKey }: { slug: string; issueKey: string }) {
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'
  const [newLabel, setNewLabel] = useState('')
  const [editingIssue, setEditingIssue] = useState(false)
  const [creatingSubIssue, setCreatingSubIssue] = useState(false)

  const issue = useQuery({
    queryKey: ['issue', slug, issueKey],
    queryFn: () => api.get<Issue>(`/w/${slug}/issues/${issueKey}`),
  })
  const comments = useQuery({
    queryKey: ['comments', slug, 'issue', issueKey],
    queryFn: () =>
      api.get<{ comments: Comment[] }>(`/w/${slug}/issues/${issueKey}/comments`),
  })
  const evidence = useQuery({
    queryKey: ['evidence', slug, issueKey],
    queryFn: () => api.get<Evidence>(`/w/${slug}/issues/${issueKey}/evidence`),
  })
  const activity = useQuery({
    queryKey: ['activity', slug, { target_id: issue.data?.id }],
    enabled: Boolean(issue.data),
    queryFn: () =>
      api.get<{ activity: Activity[] }>(
        `/w/${slug}/activity?target_type=issue&target_id=${issue.data?.id}`,
      ),
  })
  const labels = useQuery({
    queryKey: ['labels', slug],
    queryFn: () => api.get<{ labels: Label[] }>(`/w/${slug}/labels`),
  })
  const members = useQuery({
    queryKey: ['members', slug],
    queryFn: () => api.get<{ members: User[] }>(`/w/${slug}/members`),
  })
  const milestones = useQuery({
    queryKey: ['milestones', slug, 'all'],
    queryFn: () => api.get<{ milestones: Milestone[] }>(`/w/${slug}/milestones`),
  })

  useEffect(() => {
    if (issue.data) document.title = `${issue.data.key} ${issue.data.title} · Velvet`
  }, [issue.data])

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['issue', slug, issueKey] })
    void queryClient.invalidateQueries({ queryKey: ['comments', slug, 'issue', issueKey] })
    void queryClient.invalidateQueries({ queryKey: ['activity', slug] })
  }

  const setStatus = useMutation({
    mutationFn: (status: IssueStatus) =>
      api.patch<Issue>(`/w/${slug}/issues/${issueKey}`, { status }),
    onSuccess: invalidate,
  })
  const addComment = useMutation({
    mutationFn: (body: string) =>
      api.post<Comment>(`/w/${slug}/issues/${issueKey}/comments`, { body }),
    onSuccess: invalidate,
  })
  const addReply = useMutation({
    mutationFn: ({ parentId, body }: { parentId: string; body: string }) =>
      api.post<Comment>(`/w/${slug}/issues/${issueKey}/comments`, {
        body, parent_id: parentId,
      }),
    onSuccess: invalidate,
  })
  const editIssue = useMutation({
    mutationFn: (input: Pick<IssueInput, 'title' | 'description' | 'priority'>) =>
      api.patch<Issue>(`/w/${slug}/issues/${issueKey}`, input),
    onSuccess: invalidate,
  })
  const createSubIssue = useMutation({
    mutationFn: (input: IssueInput) => api.post<Issue>(`/w/${slug}/issues`, input),
    onSuccess: invalidate,
  })
  const setLabels = useMutation({
    mutationFn: (labelIds: string[]) =>
      api.put<Label[]>(`/w/${slug}/issues/${issueKey}/labels`, { label_ids: labelIds }),
    onSuccess: invalidate,
  })
  const createLabel = useMutation({
    mutationFn: (name: string) => api.post<Label>(`/w/${slug}/labels`, {
      name, color: '#111111',
    }),
    onSuccess: () => {
      setNewLabel('')
      void queryClient.invalidateQueries({ queryKey: ['labels', slug] })
    },
  })
  const assignIssue = useMutation({
    mutationFn: (patch: IssueMetadataPatch) =>
      api.patch<Issue>(`/w/${slug}/issues/${issueKey}`, patch),
    onSuccess: invalidate,
  })

  if (issue.isPending) return <LoadingState />
  if (isNotFound(issue.error)) {
    return (
      <NotFoundState
        title="Issue not found"
        message={`${issueKey} does not exist in this organisation, or it has been removed.`}
        backTo={`/w/${slug}/issues`}
        backLabel="Back to issues"
      />
    )
  }
  if (issue.error || !issue.data) {
    return (
      <ErrorState
        message="Could not load this issue."
        onRetry={() => void issue.refetch()}
        retrying={issue.isRefetching}
      />
    )
  }

  const data = issue.data
  const memberChoices = (members.data?.members ?? []).map((member) => ({
    id: member.id, label: userLabel(member), user: member,
  }))
  const milestoneChoices = (milestones.data?.milestones ?? []).map((milestone) => ({
    id: milestone.id, label: milestone.name,
  }))
  const entries = buildTimeline(
    comments.data?.comments ?? [],
    activity.data?.activity ?? [],
    evidence.data,
  )

  const main = (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-grey-200 pb-4" data-testid="issue-header">
        <div className="min-w-0">
          <p className="mb-1 text-xs tracking-wide text-grey-500 uppercase">{data.key}</p>
          <h1 className="text-lg [overflow-wrap:anywhere]">{data.title}</h1>
        </div>
        {canWrite ? (
          <Button
            className="shrink-0"
            aria-controls={editingIssue ? 'issue-edit-panel' : undefined}
            onClick={() => setEditingIssue((open) => !open)}
          >
            {editingIssue ? 'Close editor' : 'Edit issue'}
          </Button>
        ) : null}
      </header>

      <section data-testid="issue-description">
        {data.description ? (
          <div className="border-b border-grey-200 pb-4 text-sm">
            <Markdown source={data.description} />
          </div>
        ) : (
          <EmptyState
            title="No description yet."
            message={canWrite ? 'Add context so the next person can pick up the work.' : 'Ask a member to add context.'}
            action={canWrite ? <Button onClick={() => setEditingIssue(true)}>Add description</Button> : undefined}
          />
        )}
      </section>

      {editingIssue ? (
        <section id="issue-edit-panel" data-testid="issue-edit-panel">
          <h2 className="mb-2 text-xs tracking-wide text-grey-500 uppercase">Edit issue</h2>
          <IssueEditForm
            issue={data}
            onSubmit={async (input) => {
              await editIssue.mutateAsync(input)
              setEditingIssue(false)
            }}
          />
        </section>
      ) : null}

      <section data-testid="issue-timeline-section">
        <h2 className="mb-2 text-xs tracking-wide text-grey-500 uppercase">Timeline</h2>
        {entries.length ? (
          <IssueTimeline
            entries={entries}
            onReply={canWrite
              ? (parentId, body) => addReply.mutateAsync({ parentId, body })
              : undefined}
          />
        ) : (
          <EmptyState
            title="No updates yet."
            message={canWrite ? 'Add the first update below.' : 'Ask a teammate to add the first update.'}
          />
        )}
        {canWrite ? <CommentComposer onSubmit={(body) => addComment.mutateAsync(body)} /> : null}
      </section>
    </div>
  )

  const sidebar = (
    <div className="space-y-6">
      <section className="border-b border-grey-200 pb-4" data-testid="issue-status-section">
        <h2 className="mb-2 text-xs tracking-wide text-grey-500 uppercase">Status</h2>
        {canWrite ? (
          <StatusSelect
            value={data.status}
            disabled={setStatus.isPending}
            onChange={(status) => setStatus.mutate(status)}
          />
        ) : (
          <div className="flex items-center gap-2">
            <StatusDot status={data.status} />
            <StatusBadge status={data.status} />
          </div>
        )}
        {setStatus.error ? (
          <p className="mt-2 text-xs text-blocked" role="alert">Could not update status. Try again.</p>
        ) : null}
      </section>

      <section data-testid="issue-metadata-section">
        {canWrite ? (
          <IssueMetadata
            priority={data.priority}
            assigneeId={data.assignee_id}
            milestoneId={data.milestone_id}
            members={memberChoices}
            milestones={milestoneChoices}
            onPatch={(patch) => assignIssue.mutateAsync(patch)}
          />
        ) : (
          <ReadOnlyIssueMetadata
            priority={data.priority}
            assigneeId={data.assignee_id}
            milestoneId={data.milestone_id}
            members={memberChoices}
            milestones={milestoneChoices}
          />
        )}
      </section>

      <section className="border-t border-grey-200 pt-4" data-testid="issue-labels-section">
        <h2 className="mb-2 text-xs tracking-wide text-grey-500 uppercase">Labels</h2>
        {canWrite ? (
          <>
            <IssueLabels
              labels={labels.data?.labels ?? []}
              selected={(data.labels ?? []).map((label) => label.id)}
              onChange={(ids) => setLabels.mutateAsync(ids)}
            />
            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (newLabel.trim()) createLabel.mutate(newLabel.trim())
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="sr-only">New label name</span>
                <input
                  className="ui-control min-h-9 w-full px-2 py-1 text-sm"
                  placeholder="New label"
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)}
                />
              </label>
              <Button type="submit" disabled={!newLabel.trim() || createLabel.isPending}>Add label</Button>
            </form>
          </>
        ) : data.labels?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {data.labels.map((label) => (
              <span key={label.id} className="border border-grey-200 px-1.5 py-1 text-xs">{label.name}</span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-grey-500">No labels yet. Ask a member to add one.</p>
        )}
      </section>

      <IssueEvidenceSection
        evidence={evidence.data}
        issueStatus={data.status}
        isPending={evidence.isPending}
        hasError={Boolean(evidence.error)}
      />

      <section className="border-t border-grey-200 pt-4" data-testid="issue-sub-issues-section">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs tracking-wide text-grey-500 uppercase">Sub-issues</h2>
          {canWrite && !data.parent_id && !creatingSubIssue ? (
            <Button onClick={() => setCreatingSubIssue(true)}>New sub-issue</Button>
          ) : null}
        </div>

        {creatingSubIssue ? (
          <div className="mt-3">
            <IssueForm
              milestoneId={data.milestone_id ?? undefined}
              parentId={data.id}
              onSubmit={async (input) => {
                await createSubIssue.mutateAsync(input)
                setCreatingSubIssue(false)
              }}
            />
            <Button className="mt-2" onClick={() => setCreatingSubIssue(false)}>Cancel</Button>
          </div>
        ) : null}

        {data.children?.length ? (
          <ul className="mt-3 divide-y divide-grey-200 border-y border-grey-200">
            {data.children.map((child) => (
              <li key={child.id} className="py-1.5 text-sm">
                <NavLink className="underline" to={`/w/${slug}/issues/${child.key}`}>
                  {child.key} {child.title}
                </NavLink>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No sub-issues yet."
            message={data.parent_id
              ? 'This issue is already nested.'
              : canWrite
                ? creatingSubIssue ? 'Use the form above to split this work.' : 'Split the work into a smaller, trackable task.'
                : 'Ask a member to split this work.'}
            action={canWrite && !data.parent_id && !creatingSubIssue
              ? <Button onClick={() => setCreatingSubIssue(true)}>New sub-issue</Button>
              : undefined}
          />
        )}
      </section>
    </div>
  )

  return <IssuePageLayout main={main} sidebar={sidebar} />
}
