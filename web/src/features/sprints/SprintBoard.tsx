import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { ErrorNote } from '../../ui/ErrorNote'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { Badge } from '@astryxdesign/core/Badge'
import { Card } from '@astryxdesign/core/Card'
import { ClickableCard } from '@astryxdesign/core/ClickableCard'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { Heading } from '@astryxdesign/core/Heading'
import { List, ListItem } from '@astryxdesign/core/List'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Text } from '@astryxdesign/core/Text'

import { NavLink } from '../../app/nav'
import { api, isNotFound, listAllWorkspaceIssues } from '../../lib/api'
import { formatDay, stateLabel } from '../../lib/formatDate'
import type { Issue, IssueStatus, Milestone, Project, Sprint, User } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState, NotFoundState } from '../../ui/QueryState'
import { RelativeTime } from '../../ui/RelativeTime'
import { STATUS_LABELS } from '../../ui/StatusBadge'
import { useSession } from '../auth/useSession'
import { MilestoneForm, type MilestoneInput } from '../work/CoreForms'
import { membersQuery, projectsQuery } from '../work/workLinks'
import { issueWork, milestoneWork, sprintPace } from './sprintDays'
import { issuesForSprint } from './sprintIssues'
import { MoveToast, SprintKanban, type StatusMove } from './SprintKanban'

type SprintView = 'list' | 'board'

/** The view lives in the URL so a board link opens as a board. */
function readView(): SprintView {
  return new URLSearchParams(window.location.search).get('view') === 'board' ? 'board' : 'list'
}

function writeView(view: SprintView) {
  const url = new URL(window.location.href)
  if (view === 'board') url.searchParams.set('view', 'board')
  else url.searchParams.delete('view')
  window.history.replaceState(window.history.state, '', url)
}

/** The board needs five readable columns. Below `lg` (1024px) the page keeps
 *  the grouped list, which already changes status per row. */
function useWideEnoughForBoard(): boolean {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setWide(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return wide
}

/** Two weeks of silence on a milestone is the signal this product exists to
 * surface, so it is stated in words and only then reinforced with amber. */
const STALE_DAYS = 14

const ISSUE_STATUS_ORDER: IssueStatus[] = [
  'in_progress',
  'in_review',
  'todo',
  'backlog',
  'done',
  'cancelled',
]

/**
 * The API currently exposes updated_at as the issue's latest activity signal.
 * These optional fields make the presentation forward-compatible if the API
 * starts returning a dedicated activity timestamp or embedded assignee.
 */
export type SprintIssue = Issue & {
  assignee?: User | null
  last_activity_at?: string | null
  last_activity?: string | null
}

export type SprintMilestone = Milestone & {
  owner?: User | null
}

function parseableTimestamp(iso: string): string {
  // PostgreSQL can emit a bare offset such as "+00". JavaScript's Date parser
  // accepts the equivalent "+00:00", which keeps relative labels readable.
  if (/[+-]\d{2}$/.test(iso)) return `${iso}:00`
  if (/[+-]\d{4}$/.test(iso)) return `${iso.slice(0, -2)}:${iso.slice(-2)}`
  return iso
}

function daysSince(iso: string, now: number = Date.now()): number {
  const then = new Date(parseableTimestamp(iso)).getTime()
  if (Number.isNaN(then)) return 0
  return Math.floor((now - then) / 864e5)
}

function milestoneCounts(milestone: Milestone): { done: number; total: number } {
  const byStatus = milestone.issue_counts ?? {}
  const total = Object.values(byStatus).reduce(
    (sum, count) => sum + (Number.isFinite(count) ? count : 0),
    0,
  )
  return { done: byStatus.done ?? 0, total }
}

function groupIssuesByStatus(issues: Issue[]): Array<{ status: IssueStatus; issues: Issue[] }> {
  const grouped = new Map<IssueStatus, Issue[]>(
    ISSUE_STATUS_ORDER.map((status) => [status, []]),
  )
  for (const issue of issues) {
    const status = issue.status as IssueStatus
    grouped.get(status)?.push(issue)
  }
  return ISSUE_STATUS_ORDER.map((status) => ({
    status,
    issues: grouped.get(status) ?? [],
  }))
}

function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

function milestoneOwner(milestone: SprintMilestone, owner?: User | null): User | null {
  return owner ?? milestone.owner ?? null
}

export interface MilestoneCardProps {
  milestone: SprintMilestone
  slug?: string
  owner?: User | null
}

function MilestoneCardContent({ milestone, owner }: { milestone: SprintMilestone; owner?: User | null }) {
  const { done, total } = milestoneCounts(milestone)
  const progress = progressPercent(done, total)
  const last = milestone.last_comment ?? null
  const age = last ? daysSince(last.created_at) : null
  const assignedTo = milestoneOwner(milestone, owner)

  return (
    <article
      data-testid={`milestone-card-${milestone.id}`}
      className="flex h-full flex-col"
    >
      <div className="flex items-start gap-3">
        <Heading level={4} accessibilityLevel={3} className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
          {milestone.name}
        </Heading>
        {/* "0/0" reads like nothing got done; an empty milestone says so instead. */}
        {total === 0 ? (
          <span className="shrink-0 text-sm text-grey-500">No issues yet</span>
        ) : (
          <span className="shrink-0 text-sm tabular-nums text-grey-500" aria-label={`${done} of ${total} issues done`}>
            {done}/{total}
          </span>
        )}
      </div>

      <div className="mt-3">
        <ProgressBar label={`${milestone.name} progress`} isLabelHidden value={progress} />
      </div>

      <div className="mt-3 flex min-h-12 items-start gap-2 text-sm">
        {last ? (
          <>
            <p className="line-clamp-2 min-w-0 flex-1 text-grey-700 [overflow-wrap:anywhere]">{last.body}</p>
            <RelativeTime iso={parseableTimestamp(last.created_at)} />
          </>
        ) : (
          // A milestone nobody has written on says so once, in the slot the
          // update would fill, rather than as two separate empty messages.
          // Only work that is under way is marked: silence on a milestone
          // that has not started is expected, not a warning.
          <p className="flex min-w-0 flex-1 items-center gap-1.5 text-grey-500">
            {milestone.status === 'in_progress' ? (
              <span className="size-1.5 shrink-0 rounded-full bg-stale" aria-hidden="true" />
            ) : null}
            No updates yet
          </p>
        )}
      </div>

      {age !== null && age >= STALE_DAYS ? (
        // Words first, colour second: the state is readable without hue.
        <p className="mt-1 flex items-center gap-1.5 text-xs text-stale">
          <span className="size-1.5 shrink-0 rounded-full bg-stale" aria-hidden="true" />
          {`No update in ${age} days`}
        </p>
      ) : null}

      {/* Pinned to the bottom edge so footers line up across a row of cards. */}
      <div className="mt-auto flex items-center gap-2 pt-3 text-xs text-grey-500">
        <span className="capitalize">{milestone.status.replace('_', ' ')}</span>
        {milestone.target_date ? <span>· due <time dateTime={milestone.target_date}>{formatDay(milestone.target_date)}</time></span> : null}
        <span className="ml-auto" title={assignedTo ? userLabel(assignedTo) : 'No owner'}>
          {assignedTo ? <Avatar user={assignedTo} /> : null}
        </span>
      </div>
    </article>
  )
}

export function MilestoneCard({ milestone, slug, owner }: MilestoneCardProps) {
  const card = <MilestoneCardContent milestone={milestone} owner={owner} />
  if (!slug) return <Card height="100%" padding={5}>{card}</Card>

  // The whole card is one link to its milestone.
  return (
    <ClickableCard label={milestone.name} href={`/w/${slug}/milestones/${milestone.id}`} height="100%" padding={5}>
      {card}
    </ClickableCard>
  )
}

/** Kept as a compatibility export for the original sprint tests and callers. */
export function MilestoneRow(props: MilestoneCardProps) {
  return <MilestoneCard {...props} />
}

function assigneeFor(issue: SprintIssue, members: Map<string, User>): User | null {
  return issue.assignee ?? (issue.assignee_id ? members.get(issue.assignee_id) ?? null : null)
}

function activityTimestamp(issue: SprintIssue): string | null {
  return issue.last_activity_at ?? issue.last_activity ?? issue.updated_at ?? null
}

function IssueAssignee({ issue, members }: { issue: SprintIssue; members: Map<string, User> }) {
  const assignee = assigneeFor(issue, members)
  if (assignee) return <Avatar user={assignee} />

  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center border border-grey-300 text-xs text-grey-500"
      title="Unassigned"
      aria-label="Unassigned"
    >
      ·
    </span>
  )
}

function IssueRow({ issue, members }: { issue: SprintIssue; members: Map<string, User> }) {
  const activity = activityTimestamp(issue)
  return (
    <span className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1 text-sm sm:flex">
      <span className="w-20 shrink-0 text-grey-500">{issue.key}</span>
      <span className="min-w-0 flex-1 break-words text-ink [overflow-wrap:anywhere]">{issue.title}</span>
      <span className="col-start-2 flex items-center gap-2 text-xs text-grey-500 sm:contents">
        <IssueAssignee issue={issue} members={members} />
        <span className="shrink-0" aria-label={`Priority P${issue.priority}`}>
          P{issue.priority}
        </span>
        {activity ? <RelativeTime iso={parseableTimestamp(activity)} /> : null}
      </span>
    </span>
  )
}

export interface IssueGroupsProps {
  issues: SprintIssue[]
  members?: User[]
  /** The workspace the issues belong to, for each row's link. */
  slug: string
}

export function IssueGroups({ issues, members = [], slug }: IssueGroupsProps) {
  const membersById = new Map(members.map((member) => [member.id, member]))
  const groups = groupIssuesByStatus(issues)
  const [openStatuses, setOpenStatuses] = useState<Set<IssueStatus>>(
    () => new Set(ISSUE_STATUS_ORDER),
  )

  function toggleStatus(status: IssueStatus) {
    setOpenStatuses((current) => {
      const next = new Set(current)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  return (
    <div className="divide-y divide-grey-200 border-b border-grey-200">
      {groups.map(({ status, issues: groupIssues }) => (
        <div key={status} data-status={status} data-open={openStatuses.has(status) ? 'true' : 'false'}>
        <Collapsible
          isOpen={openStatuses.has(status)}
          onOpenChange={() => toggleStatus(status)}
          trigger={(
            <span className="flex min-w-0 flex-1 items-baseline gap-2 py-2" data-testid={`sprint-group-${status}`}>
              <Text weight="semibold">{STATUS_LABELS[status]}</Text>
              <Text type="supporting" color="secondary" aria-label={`${groupIssues.length} ${STATUS_LABELS[status].toLowerCase()} issues`}>
                {groupIssues.length}
              </Text>
            </span>
          )}
        >
          {groupIssues.length > 0 ? (
            <List hasDividers density="balanced" edge="flush" aria-label={`${STATUS_LABELS[status]} issues`}>
              {groupIssues.map((issue) => (
                <ListItem
                  key={issue.id}
                  itemKey={issue.id}
                  href={`/w/${slug}/issues/${issue.key}`}
                  label={<IssueRow issue={issue} members={membersById} />}
                />
              ))}
            </List>
          ) : (
            <Text as="p" type="supporting" color="secondary" display="block" className="py-2">No {STATUS_LABELS[status].toLowerCase()} issues.</Text>
          )}
        </Collapsible>
        </div>
      ))}
    </div>
  )
}

export function CloseSprintAction({
  onConfirm,
  disabled = false,
}: {
  onConfirm: () => Promise<unknown> | unknown
  disabled?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function confirm() {
    setBusy(true)
    setFailed(false)
    try {
      await onConfirm()
      setConfirming(false)
    } catch {
      // Keep the dialog open, with the failure in it, so the person can retry
      // without requesting close again.
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant="danger"
        className="px-2 py-0.5 text-xs"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        Close sprint
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => { setFailed(false); setConfirming(false) }}
        title="Close this sprint?"
        description="Closing freezes this sprint's report. Open issues keep their current status."
        actionLabel="Confirm close sprint"
        pending={busy}
        error={failed ? 'Could not close the sprint. Try again, or cancel.' : null}
        onConfirm={() => void confirm()}
      />
    </>
  )
}

export function MilestoneEmptyState({
  canCreate,
  onCreate,
  slug,
}: {
  canCreate: boolean
  onCreate: () => void
  slug: string
}) {
  return (
    <EmptyState
      title="No milestones in this sprint"
      message="Create a milestone to give the work a clear destination."
      action={canCreate ? (
        <Button variant="primary" onClick={onCreate}>New milestone</Button>
      ) : (
        <NavLink to={`/w/${slug}/sprints`} className="text-sm underline">Back to sprints</NavLink>
      )}
    />
  )
}

function SprintHeader({
  sprint,
  project,
  slug,
  isAdmin,
  onActivate,
  onClose,
  stateBusy,
  work,
}: {
  sprint: Sprint
  project?: Project
  slug: string
  isAdmin: boolean
  onActivate: () => void
  onClose: () => Promise<unknown>
  stateBusy: boolean
  /** The sprint's issues as finished and total, once they have loaded. */
  work?: { done: number; total: number }
}) {
  // The same reading the Sprints page gives, so the two never disagree.
  const pace = sprint.state === 'active' && work ? sprintPace(sprint, work) : null
  return (
    <header className="border-b border-grey-200 pb-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <Text as="p" type="supporting" color="secondary" display="block" className="mb-1" data-testid="sprint-project">
            {project ? (
              <>
                <NavLink to={`/w/${slug}/issues?project=${encodeURIComponent(project.key)}`} className="underline">
                  {project.name}
                </NavLink>
                <span aria-hidden="true"> · </span>
              </>
            ) : null}
            <span>Sprint</span>
          </Text>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Heading level={1} wordBreak="break-word">{sprint.name}</Heading>
            {pace?.behind ? <Badge variant="warning" label="Behind" /> : null}
          </div>
          <Text as="p" color="secondary" display="block" className="mt-1">
            <time dateTime={sprint.starts_on}>{formatDay(sprint.starts_on)}</time> to <time dateTime={sprint.ends_on}>{formatDay(sprint.ends_on)}</time> · {stateLabel(sprint.state)}
          </Text>
          {/* How a running sprint stands, in words; amber only when it is behind. */}
          {pace && pace.total > 0 ? (
            <p className={`mt-1 text-sm ${pace.behind ? 'text-stale' : 'text-grey-500'}`} data-testid="sprint-pace">
              Day {pace.day} of {pace.length} · {pace.done} of {pace.total} {pace.total === 1 ? 'issue' : 'issues'} done
              {pace.behind ? `, with ${pace.timeGone}% of the time gone` : ''}
            </p>
          ) : null}
        </div>
        {isAdmin && sprint.state !== 'completed' ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {sprint.state === 'upcoming' ? (
              <Button className="px-2 py-0.5 text-xs" disabled={stateBusy} onClick={onActivate}>
                Activate sprint
              </Button>
            ) : null}
            {sprint.state === 'active' ? (
              <CloseSprintAction onConfirm={onClose} disabled={stateBusy} />
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  )
}

export function SprintBoard({ slug, sprintId }: { slug: string; sprintId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'
  const isAdmin = workspace?.role === 'admin'
  const [milestoneFormOpen, setMilestoneFormOpen] = useState(false)
  const [view, setView] = useState<SprintView>(readView)
  const wide = useWideEnoughForBoard()
  const [lastMove, setLastMove] = useState<{ move: StatusMove; failed: boolean } | null>(null)

  const sprint = useQuery({
    queryKey: ['sprint', slug, sprintId],
    queryFn: () => api.get<Sprint>(`/w/${slug}/sprints/${sprintId}`),
  })
  const milestones = useQuery({
    queryKey: ['milestones', slug, sprintId],
    queryFn: () =>
      api.get<{ milestones: SprintMilestone[] }>(`/w/${slug}/sprints/${sprintId}/milestones`),
  })
  const sprintIssues = useQuery({
    queryKey: ['issues', slug, { sprint_id: sprintId }],
    queryFn: () =>
      api.get<{ issues: SprintIssue[] }>(`/w/${slug}/issues?sprint_id=${encodeURIComponent(sprintId)}&limit=200`),
  })
  // Active sprints also surface work that has no milestone. The API does not
  // expose a nullable milestone filter, so fetch the workspace page and merge
  // only truly unfiled issues into the active sprint below.
  const unfiledIssues = useQuery({
    queryKey: ['issues', slug, { milestone_id: null }],
    queryFn: async () => ({ issues: await listAllWorkspaceIssues<SprintIssue>(slug) }),
  })
  const members = useQuery(membersQuery(slug))
  const projects = useQuery(projectsQuery(slug))

  useEffect(() => {
    if (sprint.data) document.title = `${sprint.data.name} · Velvet`
  }, [sprint.data])

  const createMilestone = useMutation({
    mutationFn: (input: MilestoneInput) =>
      api.post<SprintMilestone>(`/w/${slug}/sprints/${sprintId}/milestones`, input),
    onSuccess: () => {
      setMilestoneFormOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['milestones', slug, sprintId] })
    },
  })
  const changeState = useMutation({
    mutationFn: (action: 'activate' | 'close') =>
      api.post<Sprint>(`/w/${slug}/sprints/${sprintId}/${action}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint', slug, sprintId] })
      void queryClient.invalidateQueries({ queryKey: ['sprints', slug] })
    },
  })

  // A dropped card moves at once. The PATCH runs behind it, and a failure
  // puts the card back and says so, so the board never shows a status the
  // server did not accept.
  const issueKeys = [
    ['issues', slug, { sprint_id: sprintId }],
    ['issues', slug, { milestone_id: null }],
  ] as const
  const moveIssue = useMutation({
    mutationFn: (move: StatusMove) =>
      api.patch<Issue>(`/w/${slug}/issues/${move.issue.key}`, { status: move.to }),
    onMutate: async (move) => {
      await Promise.all(issueKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })))
      const previous = issueKeys.map((queryKey) => [queryKey, queryClient.getQueryData(queryKey)] as const)
      for (const queryKey of issueKeys) {
        queryClient.setQueryData<{ issues: SprintIssue[] }>(queryKey, (data) =>
          data
            ? {
                issues: data.issues.map((issue) =>
                  issue.id === move.issue.id
                    ? { ...issue, status: move.to, updated_at: new Date().toISOString() }
                    : issue,
                ),
              }
            : data,
        )
      }
      setLastMove({ move, failed: false })
      return { previous }
    },
    onError: (_error, move, context) => {
      for (const [queryKey, data] of context?.previous ?? []) queryClient.setQueryData(queryKey, data)
      setLastMove({ move, failed: true })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['issues', slug] })
      void queryClient.invalidateQueries({ queryKey: ['milestones', slug, sprintId] })
    },
  })

  function chooseView(next: SprintView) {
    setView(next)
    writeView(next)
  }

  if (isNotFound(sprint.error)) {
    return (
      <NotFoundState
        title="Sprint not found"
        message="This sprint does not exist in this organisation, or it has been removed."
        backTo={`/w/${slug}/sprints`}
        backLabel="Back to sprints"
      />
    )
  }
  const placeholderHeading = <h1 className="border-b border-grey-200 pb-4 text-lg font-medium">Sprint</h1>
  if (sprint.isPending || milestones.isPending) {
    return <div className="w-full min-w-0 space-y-8">{placeholderHeading}<LoadingState /></div>
  }
  if (sprint.error || milestones.error || !sprint.data || !milestones.data) {
    return (
      <div className="w-full min-w-0 space-y-8">
      {placeholderHeading}
      <ErrorState
        message="Could not load this sprint."
        onRetry={() => {
          void sprint.refetch()
          void milestones.refetch()
        }}
        retrying={sprint.isRefetching || milestones.isRefetching}
      />
      </div>
    )
  }

  const sprintData = sprint.data
  const project = projects.data?.projects.find((item) => item.id === sprintData.project_id)
  const milestoneRows = milestones.data.milestones
  const issueRows = issuesForSprint(
    sprintData.state,
    sprintIssues.data?.issues ?? [],
    unfiledIssues.data?.issues ?? [],
    sprintData.project_id,
  )
  const canCreateMilestone = canWrite && sprintData.state !== 'completed'
  const milestoneAction = () => setMilestoneFormOpen(true)
  const openIssue = (issue: SprintIssue) => {
    void navigate({ href: `/w/${slug}/issues/${issue.key}` })
  }
  const showBoard = view === 'board' && wide
  const issueGroups = showBoard ? (
    <SprintKanban
      issues={issueRows}
      members={members.data?.members ?? []}
      milestones={milestoneRows}
      canWrite={canWrite}
      onOpen={openIssue}
      onMove={(move) => moveIssue.mutate(move)}
    />
  ) : (
    <IssueGroups
      issues={issueRows}
      members={members.data?.members ?? []}
      slug={slug}
    />
  )

  return (
    <div className="w-full min-w-0 space-y-8">
      <SprintHeader
        sprint={sprintData}
        project={project}
        slug={slug}
        isAdmin={isAdmin}
        onActivate={() => changeState.mutate('activate')}
        onClose={() => changeState.mutateAsync('close')}
        stateBusy={changeState.isPending}
        // Every issue listed below, counted once both lists have loaded. If
        // the unfiled ones cannot be read, the milestones' counts stand in.
        work={sprintIssues.data && unfiledIssues.data
          ? issueWork(issueRows)
          : sprintIssues.data || unfiledIssues.error ? milestoneWork(milestoneRows) : undefined}
      />

      {changeState.error ? (
        <ErrorNote>Could not change the sprint state. Try again.</ErrorNote>
      ) : null}

      <section aria-labelledby="sprint-milestones-heading">
        <SectionHeader
          id="sprint-milestones-heading"
          title="Milestones"
          action={milestoneRows.length > 0 && canCreateMilestone ? (
            <Button variant="primary" onClick={milestoneAction}>New milestone</Button>
          ) : undefined}
        />

        {milestoneRows.length === 0 ? (
          <MilestoneEmptyState
            canCreate={canCreateMilestone}
            onCreate={milestoneAction}
            slug={slug}
          />
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {milestoneRows.map((milestone) => (
              <MilestoneCard
                key={milestone.id}
                milestone={milestone}
                slug={slug}
                owner={members.data?.members.find((member) => member.id === milestone.owner_id)}
              />
            ))}
          </div>
        )}

        {milestoneFormOpen && canCreateMilestone ? (
          <div className="mt-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <Heading level={4} accessibilityLevel={3}>New milestone</Heading>
              <Button className="px-2 py-0.5 text-xs" onClick={() => setMilestoneFormOpen(false)}>Cancel</Button>
            </div>
            <MilestoneForm
              members={(members.data?.members ?? []).map((member) => ({
                id: member.id,
                label: userLabel(member),
              }))}
              onSubmit={(input) => createMilestone.mutateAsync(input)}
            />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="sprint-issues-heading">
        <SectionHeader
          id="sprint-issues-heading"
          title="Issues"
          meta={sprintIssues.data || unfiledIssues.data ? `${issueRows.length} total` : undefined}
          action={wide ? (
            <SegmentedControl
              label="Issue view"
              size="sm"
              value={view}
              onChange={(next) => chooseView(next === 'board' ? 'board' : 'list')}
            >
              <SegmentedControlItem value="list" label="List" />
              <SegmentedControlItem value="board" label="Board" />
            </SegmentedControl>
          ) : undefined}
        />
        {sprintIssues.isPending || unfiledIssues.isPending ? (
          <LoadingState label="Loading issues…" />
        ) : sprintIssues.error ? (
          <ErrorState
            message="Could not load this sprint's issues."
            onRetry={() => void sprintIssues.refetch()}
            retrying={sprintIssues.isRefetching}
          />
        ) : unfiledIssues.error && issueRows.length > 0 ? (
          <>
            <p className="mb-2 text-sm text-grey-500">Unfiled issues could not be loaded.</p>
            {issueGroups}
          </>
        ) : issueRows.length === 0 ? (
          <EmptyState
            title="No issues in this sprint"
            message="Issues without a milestone remain visible here when they are filed to the sprint."
            action={<NavLink to={`/w/${slug}/sprints`} className="text-sm underline">Back to sprints</NavLink>}
          />
        ) : (
          issueGroups
        )}
        {lastMove ? (
          <MoveToast
            move={lastMove.move}
            failed={lastMove.failed}
            onUndo={() => {
              const { move } = lastMove
              const current = issueRows.find((issue) => issue.id === move.issue.id) ?? move.issue
              moveIssue.mutate({ issue: current, from: move.to, to: move.from })
            }}
            onDismiss={() => setLastMove(null)}
          />
        ) : null}
      </section>
    </div>
  )
}
