import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { api } from '../../lib/api'
import type { Comment, Issue, Milestone, MilestoneStatus, User } from '../../lib/types'
import { Markdown } from '../../ui/Markdown'
import { CommentComposer } from '../comments/CommentComposer'
import { CommentThread } from '../comments/CommentThread'
import { IssueList } from '../issues/IssueList'
import { useSession } from '../auth/useSession'
import {
  IssueForm,
  MilestoneEditForm,
  type IssueInput,
  type MilestoneInput,
} from '../work/CoreForms'

export function MilestonePage({ slug, milestoneId }: { slug: string; milestoneId: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'

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
  const members = useQuery({
    queryKey: ['members', slug],
    queryFn: () => api.get<{ members: User[] }>(`/w/${slug}/members`),
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
  const addReply = useMutation({
    mutationFn: ({ parentId, body }: { parentId: string; body: string }) =>
      api.post<Comment>(`/w/${slug}/milestones/${milestoneId}/comments`, {
        body, parent_id: parentId,
      }),
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: ['comments', slug, 'milestone', milestoneId],
    }),
  })
  const createIssue = useMutation({
    mutationFn: (input: IssueInput) => api.post<Issue>(`/w/${slug}/issues`, input),
    onSuccess: (issue) => {
      void queryClient.invalidateQueries({ queryKey: ['issues', slug] })
      void navigate({ href: `/w/${slug}/issues/${issue.key}` })
    },
  })
  const editMilestone = useMutation({
    mutationFn: (input: MilestoneInput & { status: MilestoneStatus }) =>
      api.patch<Milestone>(`/w/${slug}/milestones/${milestoneId}`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['milestone', slug, milestoneId] })
      void queryClient.invalidateQueries({ queryKey: ['milestones', slug] })
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

      {canWrite ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm underline">Edit milestone</summary>
          <div className="mt-2">
            <MilestoneEditForm
              milestone={milestone.data}
              members={(members.data?.members ?? []).map((member) => ({
                id: member.id, label: member.github_login,
              }))}
              onSubmit={(input) => editMilestone.mutateAsync(input)}
            />
          </div>
        </details>
      ) : null}

      <section className="mt-4">
        <h2 className="mb-2 text-sm tracking-wide text-grey-500 uppercase">Issues</h2>
        {canWrite ? (
          <details className="mb-3">
            <summary className="cursor-pointer text-sm underline">New issue</summary>
            <div className="mt-2">
              <IssueForm milestoneId={milestoneId} onSubmit={(input) => createIssue.mutateAsync(input)} />
            </div>
          </details>
        ) : null}
        <IssueList
          issues={issues.data?.issues ?? []}
          onOpen={(issue) => void navigate({ href: `/w/${slug}/issues/${issue.key}` })}
        />
      </section>

      <section className="mt-4">
        {/* The thread is the milestone's narrative log, which is why it reads
            oldest first rather than newest first. */}
        <h2 className="mb-2 text-sm tracking-wide text-grey-500 uppercase">Log</h2>
        <CommentThread
          comments={comments.data?.comments ?? []}
          onReply={canWrite
            ? (parentId, body) => addReply.mutateAsync({ parentId, body })
            : undefined}
        />
        {canWrite ? (
          <CommentComposer
            placeholder="Where does this stand?"
            onSubmit={(body) => addComment.mutateAsync(body)}
          />
        ) : null}
      </section>
    </div>
  )
}
