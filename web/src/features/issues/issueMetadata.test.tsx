import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { IssueMetadata, ReadOnlyIssueMetadata } from './IssueMetadata'
import { chooseOption, dropdown, optionLabels, optionList } from '../../test-utils'

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

  await chooseOption(user, dropdown('Assignee'), 'u1')
  await chooseOption(user, dropdown('Milestone'), 'm1')
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

  expect(dropdown('Project')).toHaveAttribute('data-value', '')
  expect(optionList(dropdown('Milestone'))).toHaveTextContent('Web · September 2026')

  await chooseOption(user, dropdown('Project'), 'p1')
  expect(onPatch).toHaveBeenCalledWith({ project_id: 'p1' })

  await chooseOption(user, dropdown('Project'), '')
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

  await chooseOption(user, dropdown('Assignee'), 'u1')

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

  expect(optionLabels(dropdown('Priority'))).toEqual(expect.arrayContaining(['P0 (none)', 'P4']))
  expect(screen.getByRole('img', { name: 'Sabari' })).toBeInTheDocument()

  await chooseOption(user, dropdown('Priority'), '4')
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

  expect(screen.getByText('P3')).toBeInTheDocument()
  expect(screen.getByText('sabari')).toBeInTheDocument()
  expect(screen.getByText('Web')).toBeInTheDocument()
  expect(screen.getByText('Ship auth')).toBeInTheDocument()
  expect(screen.getByText('Web · September 2026')).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).toBeNull()
})
