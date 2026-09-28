import { useState } from 'react'

import type { User } from '../../lib/types'
import { Avatar } from '../../ui/Avatar'
import { MilestoneOptions } from '../work/CoreForms'
import type { MilestoneChoice, ProjectChoice } from '../work/workLinks'

export interface Choice {
  id: string
  label: string
  user?: User | null
}

export interface IssueMetadataPatch {
  assignee_id?: string
  milestone_id?: string
  project_id?: string
  priority?: number
}

function ChoiceAvatar({ choice }: { choice?: Choice }) {
  if (choice?.user) return <Avatar user={choice.user} />
  if (!choice) return null

  return (
    <span
      aria-hidden="true"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center border border-grey-300 bg-grey-100 text-xs"
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
  projectId = null,
  milestoneId,
  members,
  projects = [],
  milestones,
}: {
  priority: number
  assigneeId: string | null
  projectId?: string | null
  milestoneId: string | null
  members: Choice[]
  projects?: ProjectChoice[]
  milestones: MilestoneChoice[]
}) {
  const assignee = members.find((member) => member.id === assigneeId)
  const project = projects.find((item) => item.id === projectId)
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
      <div data-testid="issue-project-field">
        <dt>{metadataLabel('Project')}</dt>
        <dd className="mt-1 text-ink">{project?.label ?? 'No project'}</dd>
      </div>
      <div data-testid="issue-milestone-field">
        <dt>{metadataLabel('Milestone')}</dt>
        <dd className="mt-1 text-ink">
          {milestone ? (
            <>
              {milestone.label}
              <span className="block text-xs text-grey-500">{milestone.group}</span>
            </>
          ) : 'Unfiled'}
        </dd>
      </div>
    </dl>
  )
}

export function IssueMetadata({
  priority = 0,
  assigneeId,
  projectId = null,
  milestoneId,
  members,
  projects = [],
  milestones,
  onPatch,
}: {
  priority?: number
  assigneeId: string | null
  projectId?: string | null
  milestoneId: string | null
  members: Choice[]
  projects?: ProjectChoice[]
  milestones: MilestoneChoice[]
  onPatch: (patch: IssueMetadataPatch) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const selectedAssignee = members.find((member) => member.id === assigneeId)
  const selectClass = 'ui-control min-w-0 max-w-full flex-1 px-2 py-1 text-sm'

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

      <div className="text-sm">
        <label className="block" data-testid="issue-project-field" htmlFor="issue-project">
          {metadataLabel('Project')}
          <select
            id="issue-project"
            data-testid="issue-project-picker"
            className={`${selectClass} mt-1 block w-full`}
            aria-label="Project"
            aria-describedby="issue-project-help"
            value={projectId ?? ''}
            disabled={busy}
            onChange={(event) => void update({ project_id: event.target.value })}
          >
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.label}
              </option>
            ))}
          </select>
        </label>
        <p id="issue-project-help" className="mt-1 text-xs text-grey-500">
          A milestone belongs to one project, so choosing one sets this too.
        </p>
      </div>

      <label className="block text-sm" data-testid="issue-milestone-field" htmlFor="issue-milestone">
        {metadataLabel('Milestone')}
        <select
          id="issue-milestone"
          data-testid="issue-milestone-picker"
          className={`${selectClass} mt-1 block w-full`}
          aria-label="Milestone"
          value={milestoneId ?? ''}
          disabled={busy}
          onChange={(event) => void update({ milestone_id: event.target.value })}
        >
          <MilestoneOptions milestones={milestones} emptyLabel="Unfiled" />
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
