import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { IssueMetadata, ReadOnlyIssueMetadata } from './IssueMetadata'

it('updates assignee and milestone through named selectors', async () => {
  const onPatch = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<IssueMetadata
    assigneeId={null}
    milestoneId={null}
    members={[{ id: 'u1', label: 'sabari' }]}
    milestones={[{ id: 'm1', label: 'Ship auth' }]}
    onPatch={onPatch}
  />)

  await user.selectOptions(screen.getByLabelText('Assignee'), 'u1')
  await user.selectOptions(screen.getByLabelText('Milestone'), 'm1')
  expect(onPatch).toHaveBeenNthCalledWith(1, { assignee_id: 'u1' })
  expect(onPatch).toHaveBeenNthCalledWith(2, { milestone_id: 'm1' })
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

it('renders issue metadata without controls for a viewer', () => {
  render(<ReadOnlyIssueMetadata
    priority={3}
    assigneeId="u1"
    milestoneId="m1"
    members={[{ id: 'u1', label: 'sabari' }]}
    milestones={[{ id: 'm1', label: 'Ship auth' }]}
  />)

  expect(screen.getByText('3')).toBeInTheDocument()
  expect(screen.getByText('sabari')).toBeInTheDocument()
  expect(screen.getByText('Ship auth')).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).toBeNull()
})
