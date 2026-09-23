import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  CloseSprintAction,
  IssueGroups,
  MilestoneEmptyState,
  MilestoneRow,
  type SprintIssue,
} from './SprintBoard'
import { issuesForSprint } from './sprintIssues'

const base = {
  id: 'm1',
  workspace_id: 'w1',
  sprint_id: 's1',
  name: 'Ship auth',
  description: '',
  owner_id: null,
  target_date: null,
  status: 'in_progress' as const,
  position: 'V',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const issue = (id: string, status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled') => ({
  id,
  workspace_id: 'w1',
  key: `ENG-${id}`,
  number: Number(id.replace('i', '')),
  title: `${status} issue`,
  description: '',
  status,
  priority: 2,
  assignee_id: null,
  milestone_id: null,
  project_id: null,
  parent_id: null,
  position: 'V',
  created_by: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
})

describe('MilestoneRow', () => {
  it('shows counts and the latest comment, because the comment carries more', () => {
    render(<MilestoneRow milestone={{
      ...base,
      issue_counts: { done: 3, in_progress: 5 },
      last_comment: {
        id: 'c1',
        body: 'Blocked on vendor access',
        created_at: new Date().toISOString(),
      },
    }} />)

    expect(screen.getByText('3/8')).toBeInTheDocument()
    expect(screen.getByText(/Blocked on vendor access/)).toBeInTheDocument()
  })

  it('marks a silent milestone as stale rather than leaving it looking healthy', () => {
    const threeWeeksAgo = new Date(Date.now() - 21 * 864e5).toISOString()
    render(<MilestoneRow milestone={{
      ...base,
      issue_counts: { in_progress: 4 },
      last_comment: { id: 'c1', body: 'Starting', created_at: threeWeeksAgo },
    }} />)

    expect(screen.getByText(/no update in 21 days/i)).toBeInTheDocument()
  })

  it('handles a milestone with no comments at all', () => {
    render(<MilestoneRow milestone={{ ...base, issue_counts: {}, last_comment: null }} />)
    expect(screen.getByText(/no updates yet/i)).toBeInTheDocument()
  })

  it('shows a thin progress bar for the done/total rollup', () => {
    render(<MilestoneRow milestone={{ ...base, issue_counts: { done: 3, todo: 5 }, last_comment: null }} />)

    expect(screen.getByRole('progressbar', { name: 'Ship auth progress' })).toHaveAttribute('aria-valuenow', '38')
    expect(screen.getByText('3/8')).toBeInTheDocument()
  })
})

describe('IssueGroups', () => {
  it('renders every status in the fixed order with its count, including unfiled issues', () => {
    const { container } = render(
      <IssueGroups
        issues={[issue('i5', 'done'), issue('i1', 'in_progress'), issue('i6', 'cancelled')]}
      />,
    )

    const summaries = [...container.querySelectorAll('summary')].map((summary) =>
      summary.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(summaries).toEqual([
      'In progress 1',
      'In review 0',
      'Todo 0',
      'Backlog 0',
      'Done 1',
      'Cancelled 1',
    ])
    expect(screen.getByText('ENG-i1')).toBeInTheDocument()
    expect(screen.getByText('ENG-i5')).toBeInTheDocument()
    expect(screen.getByText('ENG-i6')).toBeInTheDocument()
  })
})

describe('issuesForSprint', () => {
  it('keeps unfiled work reachable only from the active sprint', () => {
    const filed: SprintIssue = { ...issue('i1', 'in_progress'), milestone_id: 'm1' }
    const unfiled: SprintIssue = issue('i2', 'todo')

    expect(issuesForSprint('active', [filed], [unfiled])).toEqual([filed, unfiled])
    expect(issuesForSprint('upcoming', [filed], [unfiled])).toEqual([filed])
    expect(issuesForSprint('completed', [filed], [unfiled])).toEqual([filed])
  })
})

describe('CloseSprintAction', () => {
  it('requires a second confirmation before invoking close', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CloseSprintAction onConfirm={confirm} />)

    await user.click(screen.getByRole('button', { name: 'Close sprint' }))
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByText(/freezes this sprint's report/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm close sprint' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm close sprint' }))
    expect(confirm).toHaveBeenCalledOnce()
  })
})

describe('MilestoneEmptyState', () => {
  it('offers an action instead of dead empty-state text', async () => {
    const create = vi.fn()
    const user = userEvent.setup()
    render(<MilestoneEmptyState canCreate onCreate={create} slug="lab" />)

    const action = screen.getByRole('button', { name: 'New milestone' })
    expect(action).toBeInTheDocument()
    await user.click(action)
    expect(create).toHaveBeenCalledOnce()
  })
})
