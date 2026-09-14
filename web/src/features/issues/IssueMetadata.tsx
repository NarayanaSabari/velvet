import { useState } from 'react'

import type { User } from '../../lib/types'
import { Avatar } from '../../ui/Avatar'

export interface Choice {
  id: string
  label: string
  user?: User | null
}

export interface IssueMetadataPatch {
  assignee_id?: string
  milestone_id?: string
  priority?: number
}

function ChoiceAvatar({ choice }: { choice?: Choice }) {
  if (choice?.user) return <Avatar user={choice.user} />
  if (!choice) return null

  return (
    <span
      aria-hidden="true"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center border border-grey-300 bg-grey-100 text-[9px]"
    >
      {choice.label.slice(0, 1).toUpperCase()}
    </span>
  )
}

function metadataLabel(label: string) {
  return <span className="block text-xs tracking-wide text-grey-500 uppercase">{label}</span>
}

export function ReadOnlyIssueMetadata({
  priority,
  assigneeId,
  milestoneId,
  members,
  milestones,
}: {
  priority: number
  assigneeId: string | null
  milestoneId: string | null
  members: Choice[]
  milestones: Choice[]
}) {
  const assignee = members.find((member) => member.id === assigneeId)
  const milestone = milestones.find((item) => item.id === milestoneId)

  return (
    <dl className="space-y-4 text-sm" data-testid="issue-metadata-readonly">
      <div data-testid="issue-assignee-field">
        <dt>{metadataLabel('Assignee')}</dt>
        <dd className="mt-1 flex items-center gap-2 text-ink">
          <ChoiceAvatar choice={assignee} />
          {assignee?.label ?? 'Unassigned'}
        </dd>
      </div>
      <div data-testid="issue-priority-field">
        <dt>{metadataLabel('Priority')}</dt>
        <dd className="mt-1 flex items-baseline gap-1 text-ink">
          <span>P{priority}</span>
          <span className="text-grey-500">{priority}</span>
        </dd>
      </div>
      <div data-testid="issue-milestone-field">
        <dt>{metadataLabel('Milestone')}</dt>
        <dd className="mt-1 text-ink">{milestone?.label ?? 'Unfiled'}</dd>
      </div>
    </dl>
  )
}

export function IssueMetadata({
  priority = 0,
  assigneeId,
  milestoneId,
  members,
  milestones,
  onPatch,
}: {
  priority?: number
  assigneeId: string | null
  milestoneId: string | null
  members: Choice[]
  milestones: Choice[]
  onPatch: (patch: IssueMetadataPatch) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const selectedAssignee = members.find((member) => member.id === assigneeId)
  const selectClass = 'min-w-0 flex-1 border border-grey-300 bg-paper px-1.5 py-1 text-sm'

  async function update(patch: IssueMetadataPatch) {
    setBusy(true)
    setFailed(false)
    try {
      await onPatch(patch)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="issue-metadata">
      <label className="block text-sm" data-testid="issue-assignee-field" htmlFor="issue-assignee">
        {metadataLabel('Assignee')}
        <span className="mt-1 flex items-center gap-2">
          <ChoiceAvatar choice={selectedAssignee} />
          <select
            id="issue-assignee"
            data-testid="issue-assignee-picker"
            className={selectClass}
            aria-label="Assignee"
            value={assigneeId ?? ''}
            disabled={busy}
            onChange={(event) => void update({ assignee_id: event.target.value })}
          >
            <option value="">Unassigned</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.label}
              </option>
            ))}
          </select>
        </span>
      </label>

      <label className="block text-sm" data-testid="issue-priority-field" htmlFor="issue-priority">
        {metadataLabel('Priority')}
        <select
          id="issue-priority"
          data-testid="issue-priority-picker"
          className={`${selectClass} mt-1`}
          aria-label="Priority"
          value={priority}
          disabled={busy}
          onChange={(event) => void update({ priority: Number(event.target.value) })}
        >
          {[0, 1, 2, 3, 4].map((value) => (
            <option key={value} value={value}>
              P{value}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-sm" data-testid="issue-milestone-field" htmlFor="issue-milestone">
        {metadataLabel('Milestone')}
        <select
          id="issue-milestone"
          data-testid="issue-milestone-picker"
          className={`${selectClass} mt-1`}
          aria-label="Milestone"
          value={milestoneId ?? ''}
          disabled={busy}
          onChange={(event) => void update({ milestone_id: event.target.value })}
        >
          <option value="">Unfiled</option>
          {milestones.map((milestone) => (
            <option key={milestone.id} value={milestone.id}>
              {milestone.label}
            </option>
          ))}
        </select>
      </label>

      {failed ? (
        <p className="text-xs text-blocked" role="alert">
          Could not update issue. Try again.
        </p>
      ) : null}
    </div>
  )
}
