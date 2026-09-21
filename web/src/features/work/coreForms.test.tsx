import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { IssueEditForm, IssueForm, MilestoneEditForm, MilestoneForm, SprintForm } from './CoreForms'

describe('core work forms', () => {
  it('submits a sprint with its calendar boundary', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<SprintForm onSubmit={submit} />)

    await user.type(screen.getByLabelText('Sprint name'), 'October 2026')
    await user.type(screen.getByLabelText('Starts on'), '2026-10-01')
    await user.type(screen.getByLabelText('Ends on'), '2026-10-31')
    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    expect(submit).toHaveBeenCalledWith({
      name: 'October 2026', starts_on: '2026-10-01', ends_on: '2026-10-31',
    })
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
