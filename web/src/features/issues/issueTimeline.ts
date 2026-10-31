import type { Activity, Comment, Evidence, User } from '../../lib/types'

export type TimelineEntry =
  | { kind: 'comment'; id: string; at: string; body: string; author: User | null; parentId?: string | null }
  | { kind: 'status'; id: string; at: string; from: string | null; to: string | null }
  | { kind: 'pr'; id: string; at: string; number: number; state: string }
  | { kind: 'commit'; id: string; at: string; message: string; author: string }
  | { kind: 'review'; id: string; at: string; reviewer: string; state: string }
  | { kind: 'event'; id: string; at: string; text: string }

export function buildTimeline(
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
      id: `${commit.repo_id}:${commit.sha}`,
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
