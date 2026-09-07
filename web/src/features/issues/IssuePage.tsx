import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
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
import { CommentComposer } from '../comments/CommentComposer'
import { ReplyEditor } from '../comments/CommentThread'
import { EvidenceCard } from '../evidence/EvidenceCard'
import { StatusSelect } from './StatusSelect'
import { IssueLabels } from './IssueLabels'
import { IssueMetadata, ReadOnlyIssueMetadata } from './IssueMetadata'
import { useSession } from '../auth/useSession'
import { userLabel } from '../../lib/userLabel'
import { IssueEditForm, IssueForm, type IssueInput } from '../work/CoreForms'
import { Button } from '../../ui/Button'
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

export function IssuePage({ slug, issueKey }: { slug: string; issueKey: string }) {
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'
  const [newLabel, setNewLabel] = useState('')

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
    mutationFn: (patch: { assignee_id?: string; milestone_id?: string }) =>
      api.patch<Issue>(`/w/${slug}/issues/${issueKey}`, patch),
    onSuccess: invalidate,
  })

  if (issue.isPending) return <p className="text-grey-500">Loading…</p>
  if (issue.error || !issue.data) return <p className="text-blocked">Could not load this issue.</p>

  const data = issue.data
  const memberChoices = (members.data?.members ?? []).map((member) => ({
    id: member.id, label: userLabel(member),
  }))
  const milestoneChoices = (milestones.data?.milestones ?? []).map((milestone) => ({
    id: milestone.id, label: milestone.name,
  }))
  const entries = buildTimeline(
    comments.data?.comments ?? [],
    activity.data?.activity ?? [],
    evidence.data,
  )

  return (
    <div className="max-w-3xl">
      <div className="flex items-baseline gap-2">
        <span className="text-grey-500">{data.key}</span>
        <h1 className="min-w-0 flex-1 text-lg">{data.title}</h1>
        {canWrite ? (
          <StatusSelect
            value={data.status}
            disabled={setStatus.isPending}
            onChange={(status) => setStatus.mutate(status)}
          />
        ) : <StatusBadge status={data.status} />}
      </div>

      {canWrite ? (
        <>
          <p className="mt-2 text-sm text-grey-500">Priority <span className="text-ink">{data.priority}</span></p>
          <IssueMetadata
            assigneeId={data.assignee_id}
            milestoneId={data.milestone_id}
            members={memberChoices}
            milestones={milestoneChoices}
            onPatch={(patch) => assignIssue.mutateAsync(patch)}
          />
        </>
      ) : (
        <ReadOnlyIssueMetadata
          priority={data.priority}
          assigneeId={data.assignee_id}
          milestoneId={data.milestone_id}
          members={memberChoices}
          milestones={milestoneChoices}
        />
      )}

      {data.description ? (
        <div className="mt-3 border-y border-grey-200 py-2 text-sm">
          <Markdown source={data.description} />
        </div>
      ) : null}

      {canWrite ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm underline">Edit issue</summary>
          <div className="mt-2">
            <IssueEditForm issue={data} onSubmit={(input) => editIssue.mutateAsync(input)} />
          </div>
        </details>
      ) : null}

      {canWrite && !data.parent_id ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm underline">Add sub-issue</summary>
          <div className="mt-2">
            <IssueForm
              milestoneId={data.milestone_id ?? undefined}
              parentId={data.id}
              onSubmit={(input) => createSubIssue.mutateAsync(input)}
            />
          </div>
        </details>
      ) : null}

      {data.children?.length ? (
        <section className="mt-4">
          <h2 className="mb-2 text-sm tracking-wide text-grey-500 uppercase">Sub-issues</h2>
          <ul className="divide-y divide-grey-200 border-y border-grey-200">
            {data.children.map((child) => (
              <li key={child.id} className="py-1.5 text-sm">
                <NavLink className="underline" to={`/w/${slug}/issues/${child.key}`}>
                  {child.key} {child.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-4">
        <h2 className="mb-2 text-sm tracking-wide text-grey-500 uppercase">Labels</h2>
        {canWrite ? (
          <>
            <IssueLabels
              labels={labels.data?.labels ?? []}
              selected={(data.labels ?? []).map((label) => label.id)}
              onChange={(ids) => setLabels.mutateAsync(ids)}
            />
            <form className="mt-2 flex max-w-sm gap-2" onSubmit={(event) => {
              event.preventDefault()
              if (newLabel.trim()) createLabel.mutate(newLabel.trim())
            }}>
              <label className="min-w-0 flex-1">
                <span className="sr-only">New label name</span>
                <input className="w-full border border-grey-300 bg-paper px-2 py-1 text-sm"
                  placeholder="New label" value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)} />
              </label>
              <Button type="submit" disabled={!newLabel.trim() || createLabel.isPending}>Add label</Button>
            </form>
          </>
        ) : data.labels?.length ? (
          <span className="text-sm">{data.labels.map((label) => label.name).join(', ')}</span>
        ) : (
          <span className="text-sm text-grey-500">No labels.</span>
        )}
      </section>

      {evidence.data && evidence.data.pull_requests.length > 0 ? (
        <section className="mt-4">
          <h2 className="mb-2 text-sm tracking-wide text-grey-500 uppercase">Evidence</h2>
          <div className="space-y-1">
            {evidence.data.pull_requests.map((pr) => (
              <EvidenceCard
                key={pr.id}
                pr={pr}
                issueStatus={data.status}
                // The prompt runs the ordinary status mutation, and only when
                // a person clicks it.
                onMarkDone={canWrite ? () => setStatus.mutate('done') : undefined}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-4">
        <h2 className="mb-2 text-sm tracking-wide text-grey-500 uppercase">Timeline</h2>
        <IssueTimeline
          entries={entries}
          onReply={canWrite
            ? (parentId, body) => addReply.mutateAsync({ parentId, body })
            : undefined}
        />
        {canWrite ? <CommentComposer onSubmit={(body) => addComment.mutateAsync(body)} /> : null}
      </section>
    </div>
  )
}
