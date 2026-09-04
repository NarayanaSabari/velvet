import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { MilestoneRow } from './SprintBoard'

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
})
