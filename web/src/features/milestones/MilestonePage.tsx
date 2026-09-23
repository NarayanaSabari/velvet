import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { api, isNotFound } from '../../lib/api'
import type { Comment, Issue, Milestone, MilestoneStatus, Sprint, User } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Markdown } from '../../ui/Markdown'
import { ErrorState, LoadingState, NotFoundState } from '../../ui/QueryState'
import { NavLink } from '../../app/nav'
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

const MILESTONE_STATUS_DOTS: Record<MilestoneStatus, string> = {
  planned: 'bg-grey-300',
  in_progress: 'bg-stale',
  completed: 'bg-done',
  cancelled: 'bg-blocked',
}

function milestoneStatusLabel(status: MilestoneStatus) {
  const label = status.replace('_', ' ')
  return label.slice(0, 1).toUpperCase() + label.slice(1)
}

function MilestoneStatusDot({ status }: { status: MilestoneStatus }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${MILESTONE_STATUS_DOTS[status]}`}
    />
  )
}

export function MilestonePageLayout({ main, sidebar }: { main: ReactNode; sidebar: ReactNode }) {
  return (
    <div className="w-full max-w-[80rem]" data-testid="milestone-page">
      <div
        className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]"
        data-testid="milestone-page-columns"
      >
        <div className="min-w-0" data-testid="milestone-main">
          {main}
        </div>
        <aside className="min-w-0 lg:sticky lg:top-4" data-testid="milestone-sidebar">
          {sidebar}
        </aside>
      </div>
    </div>
  )
}

export function MilestonePage({ slug, milestoneId }: { slug: string; milestoneId: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'
  const [editingMilestone, setEditingMilestone] = useState(false)
  const [creatingIssue, setCreatingIssue] = useState(false)

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
  const sprints = useQuery({
    queryKey: ['sprints', slug],
    queryFn: () => api.get<{ sprints: Sprint[] }>(`/w/${slug}/sprints`),
  })

  useEffect(() => {
    if (milestone.data) document.title = `${milestone.data.name} · Velvet`
  }, [milestone.data])

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

  if (milestone.isPending) return <LoadingState />
  if (isNotFound(milestone.error)) {
    return (
      <NotFoundState
        title="Milestone not found"
        message="This milestone does not exist in this organisation, or it has been removed."
        backTo={`/w/${slug}/sprints`}
        backLabel="Back to sprints"
      />
    )
  }
  if (milestone.error || !milestone.data) {
    return (
      <ErrorState
        message="Could not load this milestone."
        onRetry={() => void milestone.refetch()}
        retrying={milestone.isRefetching}
      />
    )
  }

  const data = milestone.data
  const milestoneIssues = issues.data?.issues ?? []
  const milestoneComments = comments.data?.comments ?? []
  const sprint = (sprints.data?.sprints ?? []).find((item) => item.id === data.sprint_id)
  const memberChoices = (members.data?.members ?? []).map((member) => ({
    id: member.id,
    label: userLabel(member),
  }))

  const main = (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-grey-200 pb-4" data-testid="milestone-header">
        <div className="min-w-0">
          <p className="mb-1 text-xs tracking-wide text-grey-500 uppercase">Milestone</p>
          <h1 className="text-lg [overflow-wrap:anywhere]">{data.name}</h1>
        </div>
        {canWrite ? (
          <Button className="shrink-0" onClick={() => setEditingMilestone((open) => !open)}>
            {editingMilestone ? 'Close editor' : 'Edit milestone'}
          </Button>
        ) : null}
      </header>

      <section data-testid="milestone-description">
        {data.description ? (
          <div className="border-b border-grey-200 pb-4 text-sm">
            <Markdown source={data.description} />
          </div>
        ) : (
          <EmptyState
            title="No description yet."
            message={canWrite ? 'Add the outcome this milestone is meant to deliver.' : 'Ask a member to add context.'}
            action={canWrite ? <Button onClick={() => setEditingMilestone(true)}>Add description</Button> : undefined}
          />
        )}
      </section>

      {editingMilestone ? (
        <section id="milestone-edit-panel" data-testid="milestone-edit-panel">
          <h2 className="mb-2 text-xs tracking-wide text-grey-500 uppercase">Edit milestone</h2>
          <MilestoneEditForm
            milestone={data}
            members={memberChoices}
            onSubmit={async (input) => {
              await editMilestone.mutateAsync(input)
              setEditingMilestone(false)
            }}
          />
        </section>
      ) : null}

      <section data-testid="milestone-log">
        <h2 className="mb-2 text-xs tracking-wide text-grey-500 uppercase">Log</h2>
        {comments.isPending ? (
          <LoadingState label="Loading updates…" />
        ) : comments.error ? (
          <ErrorState
            message="Could not load updates."
            onRetry={() => void comments.refetch()}
            retrying={comments.isRefetching}
          />
        ) : milestoneComments.length ? (
          <CommentThread
            comments={milestoneComments}
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
        {canWrite ? (
          <CommentComposer
            placeholder="Where does this stand?"
            onSubmit={(body) => addComment.mutateAsync(body)}
          />
        ) : null}
      </section>
    </div>
  )

  const sidebar = (
    <div className="space-y-6">
      <section className="border-b border-grey-200 pb-4" data-testid="milestone-metadata">
        <h2 className="mb-3 text-xs tracking-wide text-grey-500 uppercase">Details</h2>
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="text-xs tracking-wide text-grey-500 uppercase">State</dt>
            <dd className="mt-1 flex items-center gap-2 text-ink">
              <MilestoneStatusDot status={data.status} />
              <span>{milestoneStatusLabel(data.status)}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs tracking-wide text-grey-500 uppercase">Target date</dt>
            <dd className="mt-1 text-ink">
              {data.target_date ? (
                <time dateTime={data.target_date}>{data.target_date}</time>
              ) : (
                <>
                  <span className="text-grey-500">
                    {canWrite ? 'No target date.' : 'No target date. Ask a member to set one.'}
                  </span>
                  {canWrite ? (
                    <Button className="mt-2 block" onClick={() => setEditingMilestone(true)}>
                      Set target date
                    </Button>
                  ) : null}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs tracking-wide text-grey-500 uppercase">Sprint</dt>
            <dd className="mt-1">
              <span data-testid="milestone-sprint-link">
                <NavLink className="underline" to={`/w/${slug}/sprints/${data.sprint_id}`}>
                  {sprint?.name ?? 'View sprint'}
                </NavLink>
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section data-testid="milestone-issues">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs tracking-wide text-grey-500 uppercase">Issues</h2>
          {canWrite && !creatingIssue ? (
            <Button onClick={() => setCreatingIssue(true)}>New issue</Button>
          ) : null}
        </div>

        {creatingIssue ? (
          <div className="mt-3">
            <IssueForm
              milestoneId={milestoneId}
              onSubmit={(input) => createIssue.mutateAsync(input)}
            />
            <Button className="mt-2" onClick={() => setCreatingIssue(false)}>Cancel</Button>
          </div>
        ) : null}

        {issues.isPending ? (
          <div className="mt-3"><LoadingState label="Loading issues…" /></div>
        ) : issues.error ? (
          <div className="mt-3">
            <ErrorState
              message="Could not load this milestone's issues."
              onRetry={() => void issues.refetch()}
              retrying={issues.isRefetching}
            />
          </div>
        ) : milestoneIssues.length ? (
          <div className="mt-3">
            <IssueList
              issues={milestoneIssues}
              onOpen={(issue) => void navigate({ href: `/w/${slug}/issues/${issue.key}` })}
            />
          </div>
        ) : (
          <div className="mt-3">
            <EmptyState
              title="No issues in this milestone yet."
              message={canWrite
                ? creatingIssue ? 'Use the form above to add the first issue.' : 'Track the first piece of work here.'
                : 'Ask a member to add the first issue.'}
              action={canWrite && !creatingIssue
                ? <Button onClick={() => setCreatingIssue(true)}>New issue</Button>
                : undefined}
            />
          </div>
        )}
      </section>
    </div>
  )

  return <MilestonePageLayout main={main} sidebar={sidebar} />
}
