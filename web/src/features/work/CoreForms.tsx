import { useState, type FormEvent, type ReactNode } from 'react'

import type { Issue, IssueStatus, Milestone, MilestoneStatus } from '../../lib/types'
import { Button } from '../../ui/Button'
import { STATUS_LABELS } from '../../ui/StatusBadge'
import { groupChoices, reconcileLinks, type MilestoneChoice, type ProjectChoice } from './workLinks'

const inputClass = 'w-full border border-grey-300 bg-paper px-2 py-1 text-sm'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-grey-500">{label}</span>
      {children}
    </label>
  )
}

function Actions({ busy, label, error }: { busy: boolean; label: string; error: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Saving…' : label}
      </Button>
      {error ? <span className="text-sm text-blocked">Could not save. Try again.</span> : null}
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
  // With one project there is nothing to choose, and the list may arrive
  // after the form opens, so the default is worked out on every render.
  const projectId = input.project_id || (projects.length === 1 ? projects[0]?.id ?? '' : '')

  async function submit(event: FormEvent) {
    event.preventDefault()
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
      <Field label="Project">
        <select className={inputClass} required value={projectId}
          onChange={(event) => setInput({ ...input, project_id: event.target.value })}>
          <option value="" disabled>Choose a project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.label}</option>
          ))}
        </select>
      </Field>
      <Field label="Sprint name">
        <input className={inputClass} required value={input.name}
          onChange={(event) => setInput({ ...input, name: event.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Starts on">
          <input className={inputClass} required type="date" value={input.starts_on}
            onChange={(event) => setInput({ ...input, starts_on: event.target.value })} />
        </Field>
        <Field label="Ends on">
          <input className={inputClass} required type="date" value={input.ends_on}
            onChange={(event) => setInput({ ...input, ends_on: event.target.value })} />
        </Field>
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
      <Field label="Milestone name">
        <input className={inputClass} required value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Milestone description">
        <textarea className={inputClass} rows={3} value={description}
          onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <Field label="Target date">
        <input className={inputClass} type="date" value={targetDate}
          onChange={(event) => setTargetDate(event.target.value)} />
      </Field>
      {members.length ? (
        <Field label="Owner">
          <select className={inputClass} value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
            <option value="">Unassigned</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.label}</option>)}
          </select>
        </Field>
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
      <Field label="Milestone name">
        <input className={inputClass} required value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Milestone description">
        <textarea className={inputClass} rows={4} value={description}
          onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Milestone status">
          <select className={inputClass} value={status}
            onChange={(event) => setStatus(event.target.value as MilestoneStatus)}>
            {statuses.map((value) => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}
          </select>
        </Field>
        <Field label="Target date">
          <input className={inputClass} type="date" value={targetDate}
            onChange={(event) => setTargetDate(event.target.value)} />
        </Field>
      </div>
      {members.length ? (
        <Field label="Owner">
          <select className={inputClass} value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
            <option value="">Unassigned</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.label}</option>)}
          </select>
        </Field>
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

/** A milestone select whose options are grouped by project and sprint. */
export function MilestoneOptions({ milestones, emptyLabel }: { milestones: MilestoneChoice[]; emptyLabel: string }) {
  return (
    <>
      <option value="">{emptyLabel}</option>
      {groupChoices(milestones).map(({ group, items }) => (
        <optgroup key={group} label={group}>
          {items.map((milestone) => (
            <option key={milestone.id} value={milestone.id}>{milestone.label}</option>
          ))}
        </optgroup>
      ))}
    </>
  )
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
      <Field label="Issue title">
        <input className={inputClass} required value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="Issue description">
        <textarea className={inputClass} rows={3} value={description}
          onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <select className={inputClass} value={status}
            onChange={(event) => setStatus(event.target.value as IssueStatus)}>
            {(Object.keys(STATUS_LABELS) as IssueStatus[]).map((value) => (
              <option key={value} value={value}>{STATUS_LABELS[value]}</option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select className={inputClass} value={priority}
            onChange={(event) => setPriority(Number(event.target.value))}>
            {[0, 1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </Field>
      </div>
      {links ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Project">
            <select className={inputClass} value={link.projectId}
              onChange={(event) => setLink(reconcileLinks(links.milestones, link, { projectId: event.target.value }))}>
              <option value="">No project</option>
              {links.projects.map((project) => (
                <option key={project.id} value={project.id}>{project.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Milestone">
            <select className={inputClass} value={link.milestoneId}
              onChange={(event) => setLink(reconcileLinks(links.milestones, link, { milestoneId: event.target.value }))}>
              <MilestoneOptions milestones={links.milestones} emptyLabel="No milestone" />
            </select>
          </Field>
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
      <Field label="Title">
        <input className={inputClass} required value={title} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="Description">
        <textarea className={inputClass} rows={5} value={description}
          onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <Field label="Priority">
        <select className={inputClass} value={priority}
          onChange={(event) => setPriority(Number(event.target.value))}>
          {[0, 1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </Field>
      <Actions busy={busy} label="Save issue" error={failed} />
    </form>
  )
}
