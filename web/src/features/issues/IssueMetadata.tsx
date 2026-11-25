import { ErrorNote } from '../../ui/ErrorNote'
import { useState } from 'react'

import { Text } from '@astryxdesign/core/Text'

import { PRIORITIES, priorityOption } from '../../lib/priority'
import type { User } from '../../lib/types'
import { Avatar } from '../../ui/Avatar'
import { SelectField } from '../../ui/fields'
import { milestoneSelectOptions, type MilestoneChoice, type ProjectChoice } from '../work/workLinks'

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
  return <Text type="supporting" color="secondary" display="block">{label}</Text>
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
        <dd className="mt-1 text-ink">{priorityOption(priority)}</dd>
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
      <div className="flex items-end gap-2" data-testid="issue-assignee-field">
        <span className="mb-2 inline-flex">
          <ChoiceAvatar choice={selectedAssignee} />
        </span>
        <SelectField
          className="flex-1"
          label="Assignee"
          data-testid="issue-assignee-picker"
          value={assigneeId ?? ''}
          disabled={busy}
          onChange={(value) => void update({ assignee_id: value })}
          options={[
            { value: '', label: 'Unassigned' },
            ...members.map((member) => ({ value: member.id, label: member.label })),
          ]}
        />
      </div>

      <div data-testid="issue-priority-field">
        <SelectField
          label="Priority"
          data-testid="issue-priority-picker"
          value={String(priority)}
          disabled={busy}
          onChange={(value) => void update({ priority: Number(value) })}
          options={PRIORITIES.map((value) => ({ value: String(value), label: priorityOption(value) }))}
        />
      </div>

      <div data-testid="issue-project-field">
        <SelectField
          label="Project"
          description="A milestone belongs to one project, so choosing one sets this too."
          data-testid="issue-project-picker"
          value={projectId ?? ''}
          disabled={busy}
          onChange={(value) => void update({ project_id: value })}
          options={[
            { value: '', label: 'No project' },
            ...projects.map((project) => ({ value: project.id, label: project.label })),
          ]}
        />
      </div>

      <div data-testid="issue-milestone-field">
        <SelectField
          label="Milestone"
          data-testid="issue-milestone-picker"
          value={milestoneId ?? ''}
          disabled={busy}
          onChange={(value) => void update({ milestone_id: value })}
          options={milestoneSelectOptions(milestones, 'Unfiled')}
        />
      </div>

      {failed ? (
        <ErrorNote>
          Could not update issue. Try again.
        </ErrorNote>
      ) : null}
    </div>
  )
}
