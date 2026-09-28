import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { IssueEditForm, IssueForm, MilestoneEditForm, MilestoneForm, SprintForm } from './CoreForms'
import type { MilestoneChoice, ProjectChoice } from './workLinks'

const projects: ProjectChoice[] = [
  { id: 'p-web', key: 'web', label: 'Web' },
  { id: 'p-api', key: 'api', label: 'API' },
]
const milestones: MilestoneChoice[] = [
  { id: 'm-web', label: 'Ship onboarding', group: 'Web · September 2026', projectId: 'p-web' },
  { id: 'm-api', label: 'Rate limits', group: 'API · September 2026', projectId: 'p-api' },
]

describe('core work forms', () => {
  it('submits a sprint for the chosen project with its calendar boundary', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<SprintForm projects={projects} onSubmit={submit} />)

    expect(screen.getByLabelText('Project')).toBeRequired()
    await user.selectOptions(screen.getByLabelText('Project'), 'p-api')
    await user.type(screen.getByLabelText('Sprint name'), 'October 2026')
    await user.type(screen.getByLabelText('Starts on'), '2026-10-01')
    await user.type(screen.getByLabelText('Ends on'), '2026-10-31')
    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    expect(submit).toHaveBeenCalledWith({
      project_id: 'p-api', name: 'October 2026', starts_on: '2026-10-01', ends_on: '2026-10-31',
    })
  })

  it('picks the only project for a sprint without asking', () => {
    render(<SprintForm projects={[projects[0]!]} onSubmit={vi.fn()} />)
    expect(screen.getByLabelText('Project')).toHaveValue('p-web')
  })

  it('links a new issue to a project and a milestone that agree', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<IssueForm links={{ projects, milestones }} onSubmit={submit} />)

    const project = screen.getByLabelText('Project')
    const milestone = screen.getByLabelText('Milestone')
    // Milestones are grouped under the project and sprint they belong to.
    expect(screen.getByRole('group', { name: 'Web · September 2026' })).toBeInTheDocument()

    // Choosing a milestone moves the issue to that milestone's project.
    await user.selectOptions(milestone, 'm-api')
    expect(project).toHaveValue('p-api')

    // Choosing another project drops a milestone from a different project.
    await user.selectOptions(project, 'p-web')
    expect(milestone).toHaveValue('')

    await user.selectOptions(milestone, 'm-web')
    await user.type(screen.getByLabelText('Issue title'), 'Polish the empty state')
    await user.click(screen.getByRole('button', { name: 'Create issue' }))

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Polish the empty state', project_id: 'p-web', milestone_id: 'm-web',
    }))
  })

  it('leaves a new issue unfiled when no project or milestone is chosen', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<IssueForm links={{ projects, milestones }} onSubmit={submit} />)

    await user.type(screen.getByLabelText('Issue title'), 'Loose end')
    await user.click(screen.getByRole('button', { name: 'Create issue' }))

    const input = submit.mock.calls[0]![0] as Record<string, unknown>
    expect(input).not.toHaveProperty('project_id')
    expect(input).not.toHaveProperty('milestone_id')
  })

  it('submits a milestone with its narrative fields', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<MilestoneForm onSubmit={submit} />)

    await user.type(screen.getByLabelText('Milestone name'), 'Ship billing')
    await user.type(screen.getByLabelText('Milestone description'), 'Production-ready billing')
    await user.click(screen.getByRole('button', { name: 'Create milestone' }))

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Ship billing', description: 'Production-ready billing',
    }))
  })

  it('submits an issue and preserves optional parent context', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<IssueForm parentId="parent-1" onSubmit={submit} />)

    await user.type(screen.getByLabelText('Issue title'), 'Handle retries')
    await user.selectOptions(screen.getByLabelText('Priority'), '2')
    await user.click(screen.getByRole('button', { name: 'Create issue' }))

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Handle retries', priority: 2, parent_id: 'parent-1',
    }))
  })

  it('edits the issue fields that define the work record', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<IssueEditForm issue={{
      id: 'i1', workspace_id: 'w1', key: 'ENG-1', number: 1,
      title: 'Old title', description: 'Old description', status: 'todo', priority: 1,
      assignee_id: null, milestone_id: null, project_id: null, parent_id: null, position: 'V',
      created_by: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    }} onSubmit={submit} />)

    await user.clear(screen.getByLabelText('Title'))
    await user.type(screen.getByLabelText('Title'), 'New title')
    await user.selectOptions(screen.getByLabelText('Priority'), '4')
    await user.click(screen.getByRole('button', { name: 'Save issue' }))

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ title: 'New title', priority: 4 }))
  })

  it('edits milestone status and narrative', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<MilestoneEditForm milestone={{
      id: 'm1', workspace_id: 'w1', sprint_id: 's1', name: 'Ship auth',
      description: 'Old', owner_id: null, target_date: '2026-09-30', status: 'planned',
      position: 'V', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    }} onSubmit={submit} />)

    await user.selectOptions(screen.getByLabelText('Milestone status'), 'in_progress')
    await user.clear(screen.getByLabelText('Target date'))
    await user.click(screen.getByRole('button', { name: 'Save milestone' }))
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      status: 'in_progress', target_date: '',
    }))
  })
})
