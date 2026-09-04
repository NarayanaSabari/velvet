import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { api } from '../../lib/api'
import type { Comment, Issue, Milestone } from '../../lib/types'
import { Markdown } from '../../ui/Markdown'
import { CommentComposer } from '../comments/CommentComposer'
import { CommentThread } from '../comments/CommentThread'
import { IssueList } from '../issues/IssueList'

export function MilestonePage({ slug, milestoneId }: { slug: string; milestoneId: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const milestone = useQuery({
    queryKey: ['milestone', slug, milestoneId],
    queryFn: () => api.get<Milestone>(`/w/${slug}/milestones/${milestoneId}`),
  })
  const issues = useQuery({
    queryKey: ['issues', slug, { milestone_id: milestoneId }],
    queryFn: () =>
      api.get<{ issues: Issue[] }>(`/w/${slug}/issues?milestone_id=${milestoneId}`),
  })
  const comments = useQuery({
    queryKey: ['comments', slug, 'milestone', milestoneId],
    queryFn: () =>
      api.get<{ comments: Comment[] }>(`/w/${slug}/milestones/${milestoneId}/comments`),
  })

  const addComment = useMutation({
    mutationFn: (body: string) =>
      api.post<Comment>(`/w/${slug}/milestones/${milestoneId}/comments`, { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['comments', slug, 'milestone', milestoneId],
      })
      void queryClient.invalidateQueries({ queryKey: ['activity', slug] })
    },
  })

  if (milestone.isPending) return <p className="text-grey-500">Loading…</p>
  if (milestone.error || !milestone.data) {
    return <p className="text-blocked">Could not load this milestone.</p>
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-lg">{milestone.data.name}</h1>
      <p className="text-sm text-grey-500">
        {milestone.data.status}
        {milestone.data.target_date ? ` · due ${milestone.data.target_date}` : ''}
      </p>

      {milestone.data.description ? (
        <div className="mt-3 border-y border-grey-200 py-2 text-sm">
          <Markdown source={milestone.data.description} />
        </div>
      ) : null}

      <section className="mt-4">
        <h2 className="mb-2 text-sm tracking-wide text-grey-500 uppercase">Issues</h2>
        <IssueList
          issues={issues.data?.issues ?? []}
          onOpen={(issue) => void navigate({ href: `/w/${slug}/issues/${issue.key}` })}
        />
      </section>

      <section className="mt-4">
        {/* The thread is the milestone's narrative log, which is why it reads
            oldest first rather than newest first. */}
        <h2 className="mb-2 text-sm tracking-wide text-grey-500 uppercase">Log</h2>
        <CommentThread comments={comments.data?.comments ?? []} />
        <CommentComposer
          placeholder="Where does this stand?"
          onSubmit={(body) => addComment.mutateAsync(body)}
        />
      </section>
    </div>
  )
}
