import { ErrorNote } from '../../ui/ErrorNote'
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Heading } from '@astryxdesign/core/Heading'
import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'

import { api, isNotFound } from '../../lib/api'
import { PanelHeading } from '../../ui/PageHeader'
import type {
  Activity,
  Comment,
  Evidence,
  Issue,
  IssueStatus,
  Label,
} from '../../lib/types'
import { Avatar } from '../../ui/Avatar'
import { Markdown } from '../../ui/Markdown'
import { RelativeTime } from '../../ui/RelativeTime'
import { StatusBadge, STATUS_LABELS } from '../../ui/StatusBadge'
import { EmptyState } from '../../ui/EmptyState'
import { CommentComposer } from '../comments/CommentComposer'
import { ImagesSection } from '../images/ImagesSection'
import { CommentImages } from '../images/CommentImages'
import { uploadCommentImages } from '../images/uploadCommentImages'
import { ReplyEditor } from '../comments/CommentThread'
import { EvidenceCard } from '../evidence/EvidenceCard'
import { StatusDot, StatusSelect } from './StatusSelect'
import { IssueLabels } from './IssueLabels'
import { IssueMetadata, ReadOnlyIssueMetadata, type IssueMetadataPatch } from './IssueMetadata'
import { useSession } from '../auth/useSession'
import { userLabel } from '../../lib/userLabel'
import { IssueEditForm, IssueForm, type IssueInput } from '../work/CoreForms'
import { membersQuery, useWorkLinks } from '../work/workLinks'
import { Button } from '../../ui/Button'
import { ErrorState, LoadingState, NotFoundState } from '../../ui/QueryState'
import { NavLink } from '../../app/nav'
import { useReturnFocus } from './useReturnFocus'
import { buildTimeline, type TimelineEntry } from './issueTimeline'
import { TextField } from '../../ui/fields'

/** Below lg the rail falls under the narrative, so status moves up under the
 *  header instead. Without matchMedia (tests) the rail layout is assumed. */
function useLargeLayout(): boolean {
  const query = '(min-width: 1024px)'
  const [large, setLarge] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setLarge(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return large
}

function label(status: string | null): string {
  if (!status) return 'unknown'
  return STATUS_LABELS[status as IssueStatus] ?? status
}

/**
 * One unified log of everything that happened to an issue. Comments, status
 * changes, commits, PRs, and reviews are one narrative, because reading them
 * separately loses the order in which the work actually happened.
 */
export function IssueTimeline({ entries, onReply, slug }: {
  entries: TimelineEntry[]
  onReply?: (commentId: string, body: string) => Promise<unknown>
  slug?: string
}) {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at))

  if (sorted.length === 0) {
    return <EmptyState compact title="No updates yet." />
  }

  return (
    <div className="border-y border-grey-200">
      <List hasDividers density="balanced" edge="flush" aria-label="Timeline">
        {sorted.map((entry) => (
          <ListItem
            key={`${entry.kind}-${entry.id}`}
            itemKey={`${entry.kind}-${entry.id}`}
            align="start"
            // A person's comment leads with their face. Everything else is an
            // event, marked by a dot in the same column so the text lines up.
            startContent={entry.kind === 'comment' ? <Avatar user={entry.author} size="md" /> : (
              <span className="flex h-6 w-6 items-center justify-center" aria-hidden="true">
                <span className="h-1.5 w-1.5 rounded-full bg-grey-300" />
              </span>
            )}
            endContent={<RelativeTime iso={entry.at} />}
            label={entry.kind === 'comment' ? (
              <div className="min-w-0">
                <Text weight="semibold" display="block">{userLabel(entry.author)}</Text>
                <div className="mt-1 min-w-0">
                  <Markdown source={entry.body} />
                  {slug ? <CommentImages images={entry.images} slug={slug} /> : null}
                </div>
                {!entry.parentId && onReply ? (
                  <ReplyEditor commentId={entry.id} onReply={onReply} />
                ) : null}
              </div>
            ) : (
              <Text color="secondary" display="block">
                {entry.kind === 'status' ? (
                  <>Status {label(entry.from)} → {label(entry.to)}</>
                ) : entry.kind === 'pr' ? (
                  <>PR <Text color="primary">#{entry.number}</Text> {entry.state}</>
                ) : entry.kind === 'commit' ? (
                  <>{entry.author} pushed {entry.message}</>
                ) : entry.kind === 'review' ? (
                  <>{entry.reviewer} reviewed: {entry.state}</>
                ) : entry.text}
              </Text>
            )}
          />
        ))}
      </List>
    </div>
  )
}

export function IssuePageLayout({ main, sidebar }: { main: ReactNode; sidebar: ReactNode }) {
  return (
    <div className="w-full min-w-0" data-testid="issue-page">
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
      <PanelHeading>Linked PRs / evidence</PanelHeading>
      {isPending ? (
        <LoadingState label="Loading linked PRs…" />
      ) : hasError ? (
        <ErrorNote>Could not load linked PRs.</ErrorNote>
      ) : pullRequests.length === 0 ? (
        <div data-testid="issue-evidence-empty">
          <EmptyState compact title="No linked PRs." message="Branch as sabari/eng-42-... to link automatically." />
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
  const editButton = useReturnFocus(editingIssue)
  const large = useLargeLayout()

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
  const members = useQuery(membersQuery(slug))
  const links = useWorkLinks(slug, {
    projectId: issue.data?.project_id,
    milestoneId: issue.data?.milestone_id,
  })

  useEffect(() => {
    if (issue.data) document.title = `${issue.data.key} ${issue.data.title} · Velvet`
  }, [issue.data])

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['issue', slug, issueKey] })
    void queryClient.invalidateQueries({ queryKey: ['comments', slug, 'issue', issueKey] })
    void queryClient.invalidateQueries({ queryKey: ['activity', slug] })
    // The issue lists and the sprint board show the project and milestone too.
    void queryClient.invalidateQueries({ queryKey: ['issues', slug] })
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

  const pendingHeader = (
    <header className="mb-6 border-b border-grey-200 pb-4">
      <Heading level={1} wordBreak="break-word">{issueKey}</Heading>
    </header>
  )
  if (issue.isPending) return <>{pendingHeader}<LoadingState /></>
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
      <>
      {pendingHeader}
      <ErrorState
        message="Could not load this issue."
        onRetry={() => void issue.refetch()}
        retrying={issue.isRefetching}
      />
      </>
    )
  }

  const data = issue.data
  const memberChoices = (members.data?.members ?? []).map((member) => ({
    id: member.id, label: userLabel(member), user: member,
  }))
  const project = data.project_id ? links.projectById.get(data.project_id) : undefined
  const entries = buildTimeline(
    comments.data?.comments ?? [],
    activity.data?.activity ?? [],
    evidence.data,
  )

  const statusSection = (
      <section className="border-b border-grey-200 pb-4" data-testid="issue-status-section">
        <PanelHeading>Status</PanelHeading>
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
          <ErrorNote className="mt-2">Could not update status. Try again.</ErrorNote>
        ) : null}
      </section>
  )

  const main = (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-grey-200 pb-4" data-testid="issue-header">
        <div className="min-w-0">
          <Text as="p" type="supporting" color="secondary" display="block" className="mb-1" data-testid="issue-eyebrow">
            <span className="font-mono">{data.key}</span>
            {project ? (
              <>
                <span aria-hidden="true"> · </span>
                <NavLink
                  to={`/w/${slug}/issues?project=${encodeURIComponent(project.key)}`}
                  className="underline"
                >
                  {project.name}
                </NavLink>
              </>
            ) : null}
          </Text>
          <Heading level={1} wordBreak="break-word">{data.title}</Heading>
        </div>
        {canWrite ? (
          <span ref={editButton} className="shrink-0">
          <Button
            aria-expanded={editingIssue}
            aria-controls={editingIssue ? 'issue-edit-panel' : undefined}
            onClick={() => setEditingIssue((open) => !open)}
          >
            {editingIssue ? 'Close editor' : 'Edit issue'}
          </Button>
          </span>
        ) : null}
      </header>
      {editingIssue ? (
        <section id="issue-edit-panel" data-testid="issue-edit-panel">
          <PanelHeading>Edit issue</PanelHeading>
          <IssueEditForm
            issue={data}
            onSubmit={async (input) => {
              await editIssue.mutateAsync(input)
              setEditingIssue(false)
            }}
          />
        </section>
      ) : null}

      {large ? null : statusSection}

      <section data-testid="issue-description">
        {data.description ? (
          <div className="border-b border-grey-200 pb-4 text-sm">
            <Markdown source={data.description} />
          </div>
        ) : (
          <EmptyState
            compact
            title="No description yet."
            action={canWrite && !editingIssue ? <Button onClick={() => setEditingIssue(true)}>Add description</Button> : undefined}
          />
        )}
      </section>


      <ImagesSection key={`${slug}/${issueKey}`} slug={slug} target="issues" targetId={issueKey} />

      <section data-testid="issue-timeline-section">
        <PanelHeading>Timeline</PanelHeading>
        {entries.length ? (
          <IssueTimeline
            entries={entries}
            slug={slug}
            onReply={canWrite
              ? (parentId, body) => addReply.mutateAsync({ parentId, body })
              : undefined}
          />
        ) : (
          <EmptyState compact title={canWrite ? 'No updates yet.' : 'No updates yet. Ask a teammate to add the first one.'} />
        )}
        {canWrite ? (
          <CommentComposer
            onSubmit={(body) => addComment.mutateAsync(body)}
            onAttach={async (commentId, files) => {
              try {
                await uploadCommentImages(slug, 'issues', issueKey, commentId, files)
              } finally {
                invalidate()
              }
            }}
          />
        ) : null}
      </section>
    </div>
  )

  const sidebar = (
    <div className="space-y-6">
      {large ? statusSection : null}

      <section data-testid="issue-metadata-section">
        {canWrite ? (
          <IssueMetadata
            priority={data.priority}
            assigneeId={data.assignee_id}
            projectId={data.project_id}
            milestoneId={data.milestone_id}
            members={memberChoices}
            projects={links.projects}
            milestones={links.milestones}
            onPatch={(patch) => assignIssue.mutateAsync(patch)}
          />
        ) : (
          <ReadOnlyIssueMetadata
            priority={data.priority}
            assigneeId={data.assignee_id}
            projectId={data.project_id}
            milestoneId={data.milestone_id}
            members={memberChoices}
            projects={links.projects}
            milestones={links.milestones}
          />
        )}
      </section>

      <section className="border-t border-grey-200 pt-4" data-testid="issue-labels-section">
        <PanelHeading>Labels</PanelHeading>
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
              <TextField
                className="flex-1"
                label="New label name"
                hideLabel
                placeholder="New label"
                value={newLabel}
                onChange={setNewLabel}
              />
              <Button type="submit" disabled={!newLabel.trim() || createLabel.isPending}>Add label</Button>
            </form>
          </>
        ) : data.labels?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {data.labels.map((label) => (
              <Token key={label.id} label={label.name} size="sm" />
            ))}
          </div>
        ) : (
          <Text as="p" type="supporting" color="secondary" display="block">No labels yet. Ask a member to add one.</Text>
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
          <PanelHeading className="">Sub-issues</PanelHeading>
          {canWrite && !data.parent_id && !creatingSubIssue ? (
            <Button onClick={() => setCreatingSubIssue(true)}>New sub-issue</Button>
          ) : null}
        </div>

        {creatingSubIssue ? (
          <div className="mt-3">
            <IssueForm
              milestoneId={data.milestone_id ?? undefined}
              projectId={data.project_id ?? undefined}
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
          <div className="mt-3 border-y border-grey-200">
            <List hasDividers density="balanced" edge="flush" aria-label="Sub-issues">
              {data.children.map((child) => (
                <ListItem
                  key={child.id}
                  itemKey={child.id}
                  href={`/w/${slug}/issues/${child.key}`}
                  label={(
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-mono text-xs text-grey-500">{child.key}</span>
                      <span className="min-w-0 text-sm text-ink [overflow-wrap:anywhere]">{child.title}</span>
                    </span>
                  )}
                />
              ))}
            </List>
          </div>
        ) : (
          <div className="mt-3">
            <EmptyState compact title={data.parent_id ? 'No sub-issues. This issue is already nested.' : 'No sub-issues yet.'} />
          </div>
        )}
      </section>
    </div>
  )

  return <IssuePageLayout main={main} sidebar={sidebar} />
}
