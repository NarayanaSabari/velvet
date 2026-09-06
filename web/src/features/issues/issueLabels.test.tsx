import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { IssueLabels } from './IssueLabels'

it('replaces issue labels from accessible checkboxes', async () => {
  const onChange = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<IssueLabels labels={[
    { id: 'l1', workspace_id: 'w1', name: 'backend', color: '#111111' },
    { id: 'l2', workspace_id: 'w1', name: 'urgent', color: '#b91c1c' },
  ]} selected={['l1']} onChange={onChange} />)

  await user.click(screen.getByRole('checkbox', { name: 'urgent' }))
  expect(onChange).toHaveBeenCalledWith(['l1', 'l2'])
})

it('reports a failed label update', async () => {
  const onChange = vi.fn().mockRejectedValue(new Error('offline'))
  const user = userEvent.setup()
  render(<IssueLabels labels={[
    { id: 'l1', workspace_id: 'w1', name: 'backend', color: '#111111' },
  ]} selected={[]} onChange={onChange} />)

  await user.click(screen.getByRole('checkbox', { name: 'backend' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not update labels')
})
