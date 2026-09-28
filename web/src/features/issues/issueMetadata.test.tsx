import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { IssueMetadata, ReadOnlyIssueMetadata } from './IssueMetadata'

const shipAuth = { id: 'm1', label: 'Ship auth', group: 'Web · September 2026', projectId: 'p1' }

it('updates assignee and milestone through named selectors', async () => {
  const onPatch = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<IssueMetadata
    assigneeId={null}
    milestoneId={null}
    members={[{ id: 'u1', label: 'sabari' }]}
    milestones={[shipAuth]}
    onPatch={onPatch}
  />)

  await user.selectOptions(screen.getByLabelText('Assignee'), 'u1')
  await user.selectOptions(screen.getByLabelText('Milestone'), 'm1')
  expect(onPatch).toHaveBeenNthCalledWith(1, { assignee_id: 'u1' })
  expect(onPatch).toHaveBeenNthCalledWith(2, { milestone_id: 'm1' })
})

it('links the ticket to a project and groups milestones by project and sprint', async () => {
  const onPatch = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<IssueMetadata
    assigneeId={null}
    projectId={null}
    milestoneId={null}
    members={[]}
    projects={[{ id: 'p1', key: 'web', label: 'Web' }]}
    milestones={[shipAuth]}
    onPatch={onPatch}
  />)

  expect(screen.getByLabelText('Project')).toHaveValue('')
  expect(screen.getByRole('group', { name: 'Web · September 2026' })).toBeInTheDocument()

  await user.selectOptions(screen.getByLabelText('Project'), 'p1')
  expect(onPatch).toHaveBeenCalledWith({ project_id: 'p1' })

  await user.selectOptions(screen.getByLabelText('Project'), '')
  expect(onPatch).toHaveBeenLastCalledWith({ project_id: '' })
})

it('reports a failed metadata update', async () => {
  const onPatch = vi.fn().mockRejectedValue(new Error('offline'))
  const user = userEvent.setup()
  render(<IssueMetadata
    assigneeId={null}
    milestoneId={null}
    members={[{ id: 'u1', label: 'sabari' }]}
    milestones={[]}
    onPatch={onPatch}
  />)

  await user.selectOptions(screen.getByLabelText('Assignee'), 'u1')

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not update issue')
})

it('offers P0 through P4 and shows the selected member avatar', async () => {
  const onPatch = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<IssueMetadata
    priority={2}
    assigneeId="u1"
    milestoneId={null}
    members={[{
      id: 'u1',
      label: 'sabari',
      user: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: 'avatar.png' },
    }]}
    milestones={[]}
    onPatch={onPatch}
  />)

  expect(screen.getByRole('option', { name: 'P0' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'P4' })).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'Sabari' })).toBeInTheDocument()

  await user.selectOptions(screen.getByLabelText('Priority'), '4')
  expect(onPatch).toHaveBeenCalledWith({ priority: 4 })
})

it('renders issue metadata without controls for a viewer', () => {
  render(<ReadOnlyIssueMetadata
    priority={3}
    assigneeId="u1"
    projectId="p1"
    milestoneId="m1"
    members={[{ id: 'u1', label: 'sabari' }]}
    projects={[{ id: 'p1', key: 'web', label: 'Web' }]}
    milestones={[shipAuth]}
  />)

  expect(screen.getByText('3')).toBeInTheDocument()
  expect(screen.getByText('sabari')).toBeInTheDocument()
  expect(screen.getByText('Web')).toBeInTheDocument()
  expect(screen.getByText('Ship auth')).toBeInTheDocument()
  expect(screen.getByText('Web · September 2026')).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).toBeNull()
})
