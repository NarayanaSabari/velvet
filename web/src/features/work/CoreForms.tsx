import { ErrorNote } from '../../ui/ErrorNote'
import { useState, type FormEvent } from 'react'

import { PRIORITIES, priorityOption } from '../../lib/priority'
import type { Issue, IssueStatus, Milestone, MilestoneStatus } from '../../lib/types'
import { Button } from '../../ui/Button'
import { NativeField, SelectField, TextAreaField, TextField, type SelectOption } from '../../ui/fields'
import { STATUS_LABELS } from '../../ui/StatusBadge'
import { milestoneSelectOptions, reconcileLinks, type MilestoneChoice, type ProjectChoice } from './workLinks'

// The browser's own date picker, inside Astryx's label and layout.
const dateClass = 'ui-control w-full px-2 py-1 text-sm'

function DateField({ label, value, onChange, required = false }: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
}) {
  return (
    <NativeField label={label}>
      {(id) => (
        <input id={id} className={dateClass} required={required} type="date" value={value}
          onChange={(event) => onChange(event.target.value)} />
      )}
    </NativeField>
  )
}

const PRIORITY_OPTIONS: SelectOption[] = PRIORITIES.map((value) => ({ value: String(value), label: priorityOption(value) }))

function ownerOptions(members: Array<{ id: string; label: string }>): SelectOption[] {
  return [{ value: '', label: 'Unassigned' }, ...members.map((member) => ({ value: member.id, label: member.label }))]
}

function Actions({ busy, label, error }: { busy: boolean; label: string; error: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Saving…' : label}
      </Button>
      {error ? <ErrorNote className="basis-full">Could not save. Try again.</ErrorNote> : null}
    </div>
  )
}

export interface SprintInput {
  project_id: string
  name: string
  starts_on: string
  ends_on: string
}

/** A sprint belongs to one project, so the form asks which one first. */
export function SprintForm({ projects, defaultProjectId = '', onSubmit }: {
  projects: ProjectChoice[]
  defaultProjectId?: string
  onSubmit: (input: SprintInput) => Promise<unknown>
}) {
  const [input, setInput] = useState<SprintInput>({
    project_id: defaultProjectId, name: '', starts_on: '', ends_on: '',
  })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [projectMissing, setProjectMissing] = useState(false)
  // With one project there is nothing to choose, and the list may arrive
  // after the form opens, so the default is worked out on every render.
  const projectId = input.project_id || (projects.length === 1 ? projects[0]?.id ?? '' : '')

  async function submit(event: FormEvent) {
    event.preventDefault()
    // The dropdown is not a native control, so the browser cannot require it.
    if (!projectId) {
      setProjectMissing(true)
      return
    }
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit({ ...input, project_id: projectId })
      setInput({ project_id: projectId, name: '', starts_on: '', ends_on: '' })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="space-y-3 border border-grey-200 p-3" onSubmit={(event) => void submit(event)}>
      <SelectField
        autoFocus
        label="Project"
        placeholder="Choose a project"
        value={projectId}
        error={projectMissing ? 'Choose a project.' : undefined}
        onChange={(value) => {
          setProjectMissing(false)
          setInput({ ...input, project_id: value })
        }}
        options={projects.map((project) => ({ value: project.id, label: project.label }))}
      />
      <TextField label="Sprint name" required value={input.name}
        onChange={(value) => setInput({ ...input, name: value })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <DateField label="Starts on" required value={input.starts_on}
          onChange={(value) => setInput({ ...input, starts_on: value })} />
        <DateField label="Ends on" required value={input.ends_on}
          onChange={(value) => setInput({ ...input, ends_on: value })} />
      </div>
      <Actions busy={busy} label="Create sprint" error={failed} />
    </form>
  )
}

export interface MilestoneInput {
  name: string
  description: string
  target_date?: string
  owner_id?: string
}

export function MilestoneForm({ onSubmit, members = [] }: {
  onSubmit: (input: MilestoneInput) => Promise<unknown>
  members?: Array<{ id: string; label: string }>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit({
        name, description,
        ...(targetDate ? { target_date: targetDate } : {}),
        ...(ownerId ? { owner_id: ownerId } : {}),
      })
      setName('')
      setDescription('')
      setTargetDate('')
      setOwnerId('')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="space-y-3 border border-grey-200 p-3" onSubmit={(event) => void submit(event)}>
      <TextField autoFocus label="Milestone name" required value={name} onChange={setName} />
      <TextAreaField label="Milestone description" rows={3} value={description} onChange={setDescription} />
      <DateField label="Target date" value={targetDate} onChange={setTargetDate} />
      {members.length ? (
        <SelectField label="Owner" value={ownerId} onChange={setOwnerId} options={ownerOptions(members)} />
      ) : null}
      <Actions busy={busy} label="Create milestone" error={failed} />
    </form>
  )
}

export function MilestoneEditForm({
  milestone,
  onSubmit,
  members = [],
}: {
  milestone: Milestone
  onSubmit: (input: MilestoneInput & { status: MilestoneStatus }) => Promise<unknown>
  members?: Array<{ id: string; label: string }>
}) {
  const [name, setName] = useState(milestone.name)
  const [description, setDescription] = useState(milestone.description)
  const [targetDate, setTargetDate] = useState(milestone.target_date ?? '')
  const [status, setStatus] = useState<MilestoneStatus>(milestone.status)
  const [ownerId, setOwnerId] = useState(milestone.owner_id ?? '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit({
        name, description, status,
        target_date: targetDate,
        owner_id: ownerId,
      })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const statuses: MilestoneStatus[] = ['planned', 'in_progress', 'completed', 'cancelled']
  return (
    <form className="space-y-3 border border-grey-200 p-3" onSubmit={(event) => void submit(event)}>
      <TextField autoFocus label="Milestone name" required value={name} onChange={setName} />
      <TextAreaField label="Milestone description" rows={4} value={description} onChange={setDescription} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Milestone status"
          value={status}
          onChange={(value) => setStatus(value as MilestoneStatus)}
          options={statuses.map((value) => ({ value, label: value.replace('_', ' ') }))}
        />
        <DateField label="Target date" value={targetDate} onChange={setTargetDate} />
      </div>
      {members.length ? (
        <SelectField label="Owner" value={ownerId} onChange={setOwnerId} options={ownerOptions(members)} />
      ) : null}
      <Actions busy={busy} label="Save milestone" error={failed} />
    </form>
  )
}

export interface IssueInput {
  title: string
  description: string
  status: IssueStatus
  priority: number
  milestone_id?: string
  project_id?: string
  parent_id?: string
}

/** The choices behind the Project and Milestone pickers on a new issue. */
export interface IssueLinkChoices {
  projects: ProjectChoice[]
  milestones: MilestoneChoice[]
  defaultProjectId?: string
}

export function IssueForm({
  milestoneId,
  projectId,
  parentId,
  links,
  onSubmit,
}: {
  /** A fixed milestone, for forms opened from a milestone or parent issue. */
  milestoneId?: string
  /** A fixed project, for sub-issues that inherit their parent's. */
  projectId?: string
  parentId?: string
  /** When given, the form offers Project and Milestone pickers instead. */
  links?: IssueLinkChoices
  onSubmit: (input: IssueInput) => Promise<unknown>
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<IssueStatus>('backlog')
  const [priority, setPriority] = useState(0)
  const [link, setLink] = useState({ projectId: links?.defaultProjectId ?? '', milestoneId: '' })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const chosenMilestone = links ? link.milestoneId : milestoneId
  const chosenProject = links ? link.projectId : projectId

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit({
        title, description, status, priority,
        ...(chosenMilestone ? { milestone_id: chosenMilestone } : {}),
        ...(chosenProject ? { project_id: chosenProject } : {}),
        ...(parentId ? { parent_id: parentId } : {}),
      })
      setTitle('')
      setDescription('')
      setStatus('backlog')
      setPriority(0)
      setLink({ projectId: links?.defaultProjectId ?? '', milestoneId: '' })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="space-y-3 border border-grey-200 p-3" onSubmit={(event) => void submit(event)}>
      <TextField autoFocus label="Issue title" required value={title} onChange={setTitle} />
      <TextAreaField label="Issue description" rows={3} value={description} onChange={setDescription} />
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Status"
          value={status}
          onChange={(value) => setStatus(value as IssueStatus)}
          options={(Object.keys(STATUS_LABELS) as IssueStatus[]).map((value) => ({ value, label: STATUS_LABELS[value] }))}
        />
        <SelectField label="Priority" value={String(priority)} onChange={(value) => setPriority(Number(value))}
          options={PRIORITY_OPTIONS} />
      </div>
      {links ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Project"
            value={link.projectId}
            onChange={(value) => setLink(reconcileLinks(links.milestones, link, { projectId: value }))}
            options={[
              { value: '', label: 'No project' },
              ...links.projects.map((project) => ({ value: project.id, label: project.label })),
            ]}
          />
          <SelectField
            label="Milestone"
            value={link.milestoneId}
            onChange={(value) => setLink(reconcileLinks(links.milestones, link, { milestoneId: value }))}
            options={milestoneSelectOptions(links.milestones, 'No milestone')}
          />
        </div>
      ) : null}
      <Actions busy={busy} label="Create issue" error={failed} />
    </form>
  )
}

export function IssueEditForm({
  issue,
  onSubmit,
}: {
  issue: Issue
  onSubmit: (input: Pick<IssueInput, 'title' | 'description' | 'priority'>) => Promise<unknown>
}) {
  const [title, setTitle] = useState(issue.title)
  const [description, setDescription] = useState(issue.description)
  const [priority, setPriority] = useState(issue.priority)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit({ title, description, priority })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="space-y-3 border border-grey-200 p-3" onSubmit={(event) => void submit(event)}>
      <TextField autoFocus label="Title" required value={title} onChange={setTitle} />
      <TextAreaField label="Description" rows={5} value={description} onChange={setDescription} />
      <SelectField label="Priority" value={String(priority)} onChange={(value) => setPriority(Number(value))}
        options={PRIORITY_OPTIONS} />
      <Actions busy={busy} label="Save issue" error={failed} />
    </form>
  )
}
