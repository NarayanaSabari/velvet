import { useState } from 'react'

interface Choice {
  id: string
  label: string
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
  const assignee = members.find((member) => member.id === assigneeId)?.label
  const milestone = milestones.find((item) => item.id === milestoneId)?.label
  return (
    <dl className="mt-2 flex flex-wrap gap-3 text-sm text-grey-500">
      <div><dt className="inline">Priority</dt>{' '}<dd className="inline text-ink">{priority}</dd></div>
      <div><dt className="inline">Assignee</dt>{' '}<dd className="inline text-ink">{assignee ?? 'Unassigned'}</dd></div>
      <div><dt className="inline">Milestone</dt>{' '}<dd className="inline text-ink">{milestone ?? 'Unfiled'}</dd></div>
    </dl>
  )
}

export function IssueMetadata({
  assigneeId,
  milestoneId,
  members,
  milestones,
  onPatch,
}: {
  assigneeId: string | null
  milestoneId: string | null
  members: Choice[]
  milestones: Choice[]
  onPatch: (patch: { assignee_id?: string; milestone_id?: string }) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const selectClass = 'border border-grey-300 bg-paper px-1 py-0.5 text-sm'

  async function update(patch: { assignee_id?: string; milestone_id?: string }) {
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
    <div className="mt-2">
      <div className="flex flex-wrap gap-3">
        <label className="text-sm text-grey-500">
          Assignee{' '}
          <select className={selectClass} value={assigneeId ?? ''} disabled={busy}
            onChange={(event) => void update({ assignee_id: event.target.value })}>
            <option value="">Unassigned</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.label}</option>)}
          </select>
        </label>
        <label className="text-sm text-grey-500">
          Milestone{' '}
          <select className={selectClass} value={milestoneId ?? ''} disabled={busy}
            onChange={(event) => void update({ milestone_id: event.target.value })}>
            <option value="">Unfiled</option>
            {milestones.map((milestone) => (
              <option key={milestone.id} value={milestone.id}>{milestone.label}</option>
            ))}
          </select>
        </label>
      </div>
      {failed ? (
        <p className="mt-1 text-xs text-blocked" role="alert">Could not update issue. Try again.</p>
      ) : null}
    </div>
  )
}
