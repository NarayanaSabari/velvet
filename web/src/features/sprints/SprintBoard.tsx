import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import type { Issue, IssueStatus, Milestone, Sprint, User } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { List } from '../../ui/List'
import { RelativeTime } from '../../ui/RelativeTime'
import { STATUS_LABELS } from '../../ui/StatusBadge'
import { useSession } from '../auth/useSession'
import { MilestoneForm, type MilestoneInput } from '../work/CoreForms'

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

export function daysSince(iso: string, now: number = Date.now()): number {
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
  const stale = age === null || age >= STALE_DAYS
  const assignedTo = milestoneOwner(milestone, owner)

  return (
    <article
      data-testid={`milestone-card-${milestone.id}`}
      className="h-full border border-grey-300 bg-paper p-3 shadow-[2px_2px_0_var(--color-grey-200)]"
    >
      <div className="flex items-start gap-3">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {milestone.name}
        </h3>
        <span className="shrink-0 text-sm tabular-nums text-grey-500" aria-label={`${done} of ${total} issues done`}>
          {done}/{total}
        </span>
      </div>

      <div
        className="mt-3 h-1 w-full bg-grey-200"
        role="progressbar"
        aria-label={`${milestone.name} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <div className="h-full bg-ink" style={{ width: `${progress}%` }} />
      </div>

      <div className="mt-3 flex min-h-10 items-start gap-2 text-sm">
        <p className="min-w-0 flex-1 truncate text-grey-700">
          {last?.body ?? 'No updates yet'}
        </p>
        {last ? <RelativeTime iso={parseableTimestamp(last.created_at)} /> : null}
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-grey-500">
        <span className="capitalize">{milestone.status.replace('_', ' ')}</span>
        {milestone.target_date ? <span>· due {milestone.target_date}</span> : null}
        <span className="ml-auto" title={assignedTo ? userLabel(assignedTo) : 'No owner'}>
          {assignedTo ? <Avatar user={assignedTo} /> : null}
        </span>
      </div>

      {stale ? (
        // Words first, colour second: the state is readable without hue.
        <p className="mt-3 inline-block border border-stale px-1 text-xs text-stale">
          {age === null ? 'No comment yet' : `No update in ${age} days`}
        </p>
      ) : null}
    </article>
  )
}

export function MilestoneCard({ milestone, slug, owner }: MilestoneCardProps) {
  const card = <MilestoneCardContent milestone={milestone} owner={owner} />
  if (!slug) return card

  return (
    <NavLink
      to={`/w/${slug}/milestones/${milestone.id}`}
      className="block h-full text-ink no-underline hover:bg-grey-100"
    >
      {card}
    </NavLink>
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

function mergeSprintIssues(sprintIssues: SprintIssue[], unfiledIssues: SprintIssue[]): SprintIssue[] {
  const merged = new Map(sprintIssues.map((issue) => [issue.id, issue]))
  for (const issue of unfiledIssues) {
    if (issue.milestone_id === null) merged.set(issue.id, issue)
  }
  return [...merged.values()]
}

function IssueAssignee({ issue, members }: { issue: SprintIssue; members: Map<string, User> }) {
  const assignee = assigneeFor(issue, members)
  if (assignee) return <Avatar user={assignee} />

  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center border border-grey-300 text-[9px] text-grey-500"
      title="Unassigned"
      aria-label="Unassigned"
    >
      ·
    </span>
  )
}

function IssueRow({ issue, members, slug }: { issue: SprintIssue; members: Map<string, User>; slug: string }) {
  const activity = activityTimestamp(issue)
  return (
    <span className="flex items-center gap-2 text-sm">
      <NavLink to={`/w/${slug}/issues/${issue.key}`} className="w-20 shrink-0 text-grey-500">
        {issue.key}
      </NavLink>
      <NavLink to={`/w/${slug}/issues/${issue.key}`} className="min-w-0 flex-1 truncate text-ink">
        {issue.title}
      </NavLink>
      <IssueAssignee issue={issue} members={members} />
      <span className="shrink-0 text-xs text-grey-500" aria-label={`Priority P${issue.priority}`}>
        P{issue.priority}
      </span>
      {activity ? <RelativeTime iso={parseableTimestamp(activity)} /> : null}
    </span>
  )
}

export interface IssueGroupsProps {
  issues: SprintIssue[]
  members?: User[]
  slug?: string
  onOpen?: (issue: SprintIssue) => void
}

export function IssueGroups({ issues, members = [], slug = '', onOpen }: IssueGroupsProps) {
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
    <div className="divide-y divide-grey-200 border-y border-grey-200">
      {groups.map(({ status, issues: groupIssues }) => (
        <details key={status} data-status={status} open={openStatuses.has(status)}>
          <summary
            className="flex cursor-pointer items-center gap-3 px-2 py-2 text-sm hover:bg-grey-100"
            aria-expanded={openStatuses.has(status)}
            onClick={(event) => {
              event.preventDefault()
              toggleStatus(status)
            }}
          >
            <span className="min-w-0 flex-1 font-medium">{STATUS_LABELS[status]}</span>
            <span className="text-grey-500" aria-label={`${groupIssues.length} ${STATUS_LABELS[status].toLowerCase()} issues`}>
              {' '}
              {groupIssues.length}
            </span>
          </summary>
          {groupIssues.length > 0 ? (
            <List
              items={groupIssues}
              ariaLabel={`${STATUS_LABELS[status]} issues`}
              keyExtractor={(issue) => issue.id}
              onActivate={onOpen}
              renderItem={(issue) => (
                <IssueRow issue={issue} members={membersById} slug={slug} />
              )}
            />
          ) : (
            <p className="px-2 py-3 text-sm text-grey-500">No {STATUS_LABELS[status].toLowerCase()} issues.</p>
          )}
        </details>
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

  async function confirm() {
    setBusy(true)
    try {
      await onConfirm()
      setConfirming(false)
    } catch {
      // The parent mutation owns the visible error message. Keep the second
      // step open so the user can retry without requesting close again.
    } finally {
      setBusy(false)
    }
  }

  if (!confirming) {
    return (
      <Button
        variant="danger"
        className="px-2 py-0.5 text-xs"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        Close sprint
      </Button>
    )
  }

  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-xs text-grey-500">Close this sprint?</span>
      <Button
        variant="danger"
        className="px-2 py-0.5 text-xs"
        disabled={disabled || busy}
        onClick={() => void confirm()}
      >
        {busy ? 'Closing…' : 'Confirm close sprint'}
      </Button>
      <Button
        className="px-2 py-0.5 text-xs"
        disabled={disabled || busy}
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
    </span>
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
  isAdmin,
  onActivate,
  onClose,
  stateBusy,
}: {
  sprint: Sprint
  isAdmin: boolean
  onActivate: () => void
  onClose: () => Promise<unknown>
  stateBusy: boolean
}) {
  return (
    <header className="border-b border-grey-200 pb-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs tracking-wide text-grey-500 uppercase">Sprint</p>
          <h1 className="text-xl font-medium">{sprint.name}</h1>
          <p className="mt-1 text-sm text-grey-500">
            {sprint.starts_on} to {sprint.ends_on} · {sprint.state}
          </p>
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
  // There is no nullable milestone filter in the current API. Fetching the
  // workspace page separately keeps unfiled work reachable, then the merge
  // below adds only issues without a milestone to this sprint's result.
  const unfiledIssues = useQuery({
    queryKey: ['issues', slug, { milestone_id: null }],
    queryFn: () => api.get<{ issues: SprintIssue[] }>(`/w/${slug}/issues?limit=200`),
  })
  const members = useQuery({
    queryKey: ['members', slug],
    queryFn: () => api.get<{ members: User[] }>(`/w/${slug}/members`),
  })
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

  if (sprint.isPending || milestones.isPending) return <p className="text-grey-500">Loading…</p>
  if (sprint.error || milestones.error || !sprint.data || !milestones.data) {
    return <p className="text-blocked">Could not load this sprint.</p>
  }

  const sprintData = sprint.data
  const milestoneRows = milestones.data.milestones
  const issueRows = mergeSprintIssues(
    sprintIssues.data?.issues ?? [],
    unfiledIssues.data?.issues ?? [],
  )
  const canCreateMilestone = canWrite && sprintData.state !== 'completed'
  const milestoneAction = () => setMilestoneFormOpen(true)

  return (
    <div className="max-w-5xl space-y-8">
      <SprintHeader
        sprint={sprintData}
        isAdmin={isAdmin}
        onActivate={() => changeState.mutate('activate')}
        onClose={() => changeState.mutateAsync('close')}
        stateBusy={changeState.isPending}
      />

      {changeState.error ? (
        <p role="alert" className="text-sm text-blocked">Could not change the sprint state. Try again.</p>
      ) : null}

      <section aria-labelledby="sprint-milestones-heading">
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 id="sprint-milestones-heading" className="text-base font-medium">Milestones</h2>
          {milestoneRows.length > 0 && canCreateMilestone ? (
            <Button variant="primary" className="ml-auto px-2 py-0.5 text-xs" onClick={milestoneAction}>
              New milestone
            </Button>
          ) : null}
        </div>

        {milestoneRows.length === 0 ? (
          <MilestoneEmptyState
            canCreate={canCreateMilestone}
            onCreate={milestoneAction}
            slug={slug}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
              <h3 className="text-sm font-medium">New milestone</h3>
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
        <div className="mb-3 flex items-baseline gap-3">
          <h2 id="sprint-issues-heading" className="text-base font-medium">Issues</h2>
          {sprintIssues.data || unfiledIssues.data ? (
            <span className="text-sm text-grey-500">{issueRows.length} total</span>
          ) : null}
        </div>
        {sprintIssues.isPending || unfiledIssues.isPending ? (
          <p className="text-sm text-grey-500">Loading issues…</p>
        ) : sprintIssues.error ? (
          <p role="alert" className="text-sm text-blocked">Could not load this sprint's issues.</p>
        ) : unfiledIssues.error && issueRows.length > 0 ? (
          <>
            <p className="mb-2 text-sm text-grey-500">Unfiled issues could not be loaded.</p>
            {issueRows.length > 0 ? (
              <IssueGroups
                issues={issueRows}
                members={members.data?.members ?? []}
                slug={slug}
                onOpen={(issue) => {
                  void navigate({ href: `/w/${slug}/issues/${issue.key}` })
                }}
              />
            ) : null}
          </>
        ) : issueRows.length === 0 ? (
          <EmptyState
            title="No issues in this sprint"
            message="Issues without a milestone remain visible here when they are filed to the sprint."
            action={<NavLink to={`/w/${slug}/sprints`} className="text-sm underline">Back to sprints</NavLink>}
          />
        ) : (
          <IssueGroups
            issues={issueRows}
            members={members.data?.members ?? []}
            slug={slug}
            onOpen={(issue) => {
              void navigate({ href: `/w/${slug}/issues/${issue.key}` })
            }}
          />
        )}
      </section>
    </div>
  )
}
