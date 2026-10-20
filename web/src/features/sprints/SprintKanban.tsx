import { useState, type DragEvent } from 'react'

import type { IssueStatus, Milestone, User } from '../../lib/types'
import { Avatar } from '../../ui/Avatar'
import { RelativeTime } from '../../ui/RelativeTime'
import { STATUS_LABELS } from '../../ui/StatusBadge'
import { StatusDot, StatusSelect } from '../issues/StatusSelect'
import type { SprintIssue } from './SprintBoard'

/** Columns read left to right in the order work moves. Cancelled is not a
 *  column: it is folded under Done so a dead end does not take a lane. */
const BOARD_COLUMNS: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done']

/** Done grows all sprint, so it shows the latest few until asked for more. */
const DONE_PREVIEW = 3

/** Matches the Reports page: unfinished work silent this long is called out. */
const SILENT_DAYS = 5

const DRAG_TYPE = 'application/x-velvet-issue'

export interface StatusMove {
  issue: SprintIssue
  from: IssueStatus
  to: IssueStatus
}

function silentDays(issue: SprintIssue, now: number): number | null {
  if (issue.status === 'done' || issue.status === 'cancelled') return null
  const stamp = issue.last_activity_at ?? issue.last_activity ?? issue.updated_at
  if (!stamp) return null
  const days = Math.floor((now - new Date(stamp).getTime()) / 864e5)
  return days >= SILENT_DAYS ? days : null
}

function KanbanCard({
  issue,
  now,
  assignee,
  milestoneName,
  canWrite,
  dragging,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  issue: SprintIssue
  now: number
  assignee: User | null
  milestoneName?: string
  canWrite: boolean
  dragging: boolean
  onOpen: () => void
  onMove: (to: IssueStatus) => void
  onDragStart: (event: DragEvent<HTMLLIElement>) => void
  onDragEnd: () => void
}) {
  const silent = silentDays(issue, now)
  const stamp = issue.last_activity_at ?? issue.last_activity ?? issue.updated_at
  return (
    <li
      data-testid={`kanban-card-${issue.key}`}
      data-status={issue.status}
      draggable={canWrite}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`ui-surface min-w-0 rounded-[var(--radius-control)] px-2.5 py-2 ${
        canWrite ? 'cursor-grab active:cursor-grabbing' : ''
      } ${dragging ? 'opacity-40' : ''}`}
    >
      <p className="flex min-w-0 gap-2 text-xs text-grey-500">
        <span className="shrink-0">{issue.key}</span>
        {milestoneName ? <span className="min-w-0 truncate">· {milestoneName}</span> : null}
      </p>
      <a
        href={`#${issue.key}`}
        onClick={(event) => {
          event.preventDefault()
          onOpen()
        }}
        className="mt-0.5 mb-1.5 block break-words text-ink [overflow-wrap:anywhere] hover:underline"
      >
        {issue.title}
      </a>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-grey-500">
        {assignee ? <Avatar user={assignee} /> : null}
        <span aria-label={`Priority P${issue.priority}`}>P{issue.priority}</span>
        {silent !== null ? (
          <span className="whitespace-nowrap text-stale">silent {silent}d</span>
        ) : stamp ? (
          <RelativeTime iso={stamp} />
        ) : null}
        {canWrite ? (
          <span className="ml-auto">
            <StatusSelect value={issue.status} onChange={onMove} />
          </span>
        ) : null}
      </div>
    </li>
  )
}

export function SprintKanban({
  issues,
  members,
  milestones,
  canWrite,
  onOpen,
  onMove,
}: {
  issues: SprintIssue[]
  members: User[]
  milestones: Milestone[]
  canWrite: boolean
  onOpen: (issue: SprintIssue) => void
  onMove: (move: StatusMove) => void
}) {
  const membersById = new Map(members.map((member) => [member.id, member]))
  const milestoneNames = new Map(milestones.map((milestone) => [milestone.id, milestone.name]))
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overStatus, setOverStatus] = useState<IssueStatus | null>(null)
  const [showAllDone, setShowAllDone] = useState(false)
  // Read once per mount: "silent 6d" does not need to tick while visible.
  const [now] = useState(Date.now)

  const byStatus = new Map<IssueStatus, SprintIssue[]>(
    [...BOARD_COLUMNS, 'cancelled' as const].map((status) => [status, []]),
  )
  for (const issue of issues) byStatus.get(issue.status)?.push(issue)
  // Newest movement first inside a column, so a just-moved card is visible.
  for (const list of byStatus.values()) {
    list.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
  }

  function move(issue: SprintIssue, to: IssueStatus) {
    if (issue.status !== to) onMove({ issue, from: issue.status, to })
  }

  function drop(event: DragEvent<HTMLElement>, status: IssueStatus) {
    event.preventDefault()
    setOverStatus(null)
    setDraggingId(null)
    const id = event.dataTransfer.getData(DRAG_TYPE)
    const issue = issues.find((candidate) => candidate.id === id)
    if (issue) move(issue, status)
  }

  function card(issue: SprintIssue) {
    return (
      <KanbanCard
        key={issue.id}
        issue={issue}
        now={now}
        assignee={issue.assignee ?? (issue.assignee_id ? membersById.get(issue.assignee_id) ?? null : null)}
        milestoneName={issue.milestone_id ? milestoneNames.get(issue.milestone_id) : undefined}
        canWrite={canWrite}
        dragging={draggingId === issue.id}
        onOpen={() => onOpen(issue)}
        onMove={(to) => move(issue, to)}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, issue.id)
          event.dataTransfer.effectAllowed = 'move'
          setDraggingId(issue.id)
        }}
        onDragEnd={() => {
          setDraggingId(null)
          setOverStatus(null)
        }}
      />
    )
  }

  const cancelled = byStatus.get('cancelled') ?? []

  return (
    <div
      data-testid="sprint-kanban"
      className="grid min-w-0 grid-cols-5 items-start gap-3"
      aria-label="Sprint board"
      role="region"
    >
      {BOARD_COLUMNS.map((status) => {
        const columnIssues = byStatus.get(status) ?? []
        const limit = status === 'done' && !showAllDone ? DONE_PREVIEW : columnIssues.length
        const visible = columnIssues.slice(0, limit)
        const hidden = columnIssues.length - visible.length
        const headingId = `kanban-${status}-heading`
        return (
          <section
            key={status}
            aria-labelledby={headingId}
            data-testid={`kanban-column-${status}`}
            data-drop-target={overStatus === status ? 'true' : undefined}
            onDragOver={(event) => {
              if (!canWrite || !event.dataTransfer.types.includes(DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              if (overStatus !== status) setOverStatus(status)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverStatus(null)
            }}
            onDrop={(event) => drop(event, status)}
            className={`flex min-w-0 flex-col rounded-[var(--radius-surface)] border bg-grey-100 ${
              overStatus === status ? 'border-dashed border-ink' : 'border-grey-200'
            }`}
          >
            <h3
              id={headingId}
              className="flex items-center gap-2 border-b border-grey-200 px-3 py-2 text-xs font-semibold"
            >
              <StatusDot status={status} />
              <span>{STATUS_LABELS[status]}</span>
              <span
                className="ml-auto font-normal text-grey-500"
                aria-label={`${columnIssues.length} ${STATUS_LABELS[status].toLowerCase()} issues`}
              >
                {columnIssues.length}
              </span>
            </h3>
            <ul className="flex min-h-16 flex-col gap-1.5 p-2" aria-label={`${STATUS_LABELS[status]} issues`}>
              {visible.map(card)}
              {columnIssues.length === 0 ? (
                <li className="px-1 py-3 text-center text-xs text-grey-500">
                  {canWrite ? 'Drop issues here' : 'None'}
                </li>
              ) : null}
            </ul>
            {hidden > 0 ? (
              <button
                type="button"
                className="mx-2 mb-2 rounded-[var(--radius-control)] px-2 py-1 text-xs text-grey-700 hover:bg-paper"
                onClick={() => setShowAllDone(true)}
              >
                + {hidden} more · Show all
              </button>
            ) : null}
            {status === 'done' && cancelled.length > 0 ? (
              <details
                data-testid="kanban-cancelled"
                className="mx-2 mb-2 border-t border-grey-200 pt-2"
                onDragOver={(event) => {
                  if (!canWrite || !event.dataTransfer.types.includes(DRAG_TYPE)) return
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onDrop={(event) => {
                  event.stopPropagation()
                  drop(event, 'cancelled')
                }}
              >
                <summary className="flex cursor-pointer items-center gap-2 text-xs text-grey-700">
                  <StatusDot status="cancelled" />
                  Cancelled · {cancelled.length}
                </summary>
                <ul className="mt-2 flex flex-col gap-1.5" aria-label="Cancelled issues">
                  {cancelled.map(card)}
                </ul>
              </details>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

/**
 * One line of feedback after a move, with the way back. It stays until the
 * next move or a dismissal rather than timing out under a reading user.
 */
export function MoveToast({
  move,
  failed,
  onUndo,
  onDismiss,
}: {
  move: StatusMove
  failed: boolean
  onUndo: () => void
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      data-testid="kanban-toast"
      className="fixed bottom-20 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-xs text-paper sm:bottom-4"
    >
      <span className="min-w-0">
        {failed
          ? `Could not move ${move.issue.key}. It is back in ${STATUS_LABELS[move.from]}.`
          : `Moved ${move.issue.key} to ${STATUS_LABELS[move.to]}`}
      </span>
      {failed ? null : (
        <button type="button" className="underline" onClick={onUndo}>
          Undo
        </button>
      )}
      <button type="button" aria-label="Dismiss" className="text-grey-300" onClick={onDismiss}>
        ×
      </button>
    </div>
  )
}
