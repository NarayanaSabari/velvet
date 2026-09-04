import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type {
  Activity,
  Comment,
  Evidence,
  Issue,
  IssueStatus,
  User,
} from '../../lib/types'
import { Avatar } from '../../ui/Avatar'
import { Markdown } from '../../ui/Markdown'
import { RelativeTime } from '../../ui/RelativeTime'
import { STATUS_LABELS } from '../../ui/StatusBadge'
import { CommentComposer } from '../comments/CommentComposer'
import { EvidenceCard } from '../evidence/EvidenceCard'
import { StatusSelect } from './StatusSelect'

export type TimelineEntry =
  | { kind: 'comment'; id: string; at: string; body: string; author: User | null }
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
export function IssueTimeline({ entries }: { entries: TimelineEntry[] }) {
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
                    {entry.author?.github_login ?? 'Someone'}
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
  const entries: TimelineEntry[] = comments.map((c) => ({
    kind: 'comment',
    id: c.id,
    at: c.created_at,
    body: c.deleted_at ? '_Comment deleted_' : c.body,
    author: c.author ?? null,
  }))

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

  if (issue.isPending) return <p className="text-grey-500">Loading…</p>
  if (issue.error || !issue.data) return <p className="text-blocked">Could not load this issue.</p>

  const data = issue.data
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
        <StatusSelect
          value={data.status}
          disabled={setStatus.isPending}
          onChange={(status) => setStatus.mutate(status)}
        />
      </div>

      {data.description ? (
        <div className="mt-3 border-y border-grey-200 py-2 text-sm">
          <Markdown source={data.description} />
        </div>
      ) : null}

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
                onMarkDone={() => setStatus.mutate('done')}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-4">
        <h2 className="mb-2 text-sm tracking-wide text-grey-500 uppercase">Timeline</h2>
        <IssueTimeline entries={entries} />
        <CommentComposer onSubmit={(body) => addComment.mutateAsync(body)} />
      </section>
    </div>
  )
}
