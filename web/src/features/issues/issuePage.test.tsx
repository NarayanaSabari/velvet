import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { IssueTimeline } from './IssuePage'
import { EvidenceCard } from '../evidence/EvidenceCard'

describe('IssueTimeline', () => {
  it('interleaves comments, status changes, and PRs in time order', () => {
    render(<IssueTimeline entries={[
      { kind: 'comment', id: 'c1', at: '2026-09-01T10:00:00Z', body: 'Starting', author: null },
      { kind: 'status', id: 's1', at: '2026-09-01T11:00:00Z', from: 'todo', to: 'in_progress' },
      { kind: 'pr', id: 'p1', at: '2026-09-01T12:00:00Z', number: 42, state: 'merged' },
    ]} />)

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Starting')
    expect(items[2]).toHaveTextContent('#42')
  })
})

describe('EvidenceCard', () => {
  it('prompts rather than auto-completing when a PR merges', async () => {
    const onMarkDone = vi.fn()
    const user = userEvent.setup()

    render(<EvidenceCard
      pr={{
        id: 'p1', number: 42, title: 'Fix auth', state: 'merged', draft: false,
        author_login: 'sabari', additions: 10, deletions: 2,
        html_url: 'https://github.com/acme/widgets/pull/42',
        merged_at: '2026-09-01T12:00:00Z',
      }}
      issueStatus="in_progress"
      onMarkDone={onMarkDone}
    />)

    const prompt = screen.getByRole('button', { name: /mark .* done/i })
    expect(prompt).toBeInTheDocument()
    expect(onMarkDone).not.toHaveBeenCalled()

    await user.click(prompt)
    expect(onMarkDone).toHaveBeenCalledOnce()
  })

  it('does not prompt when the issue is already done', () => {
    render(<EvidenceCard
      pr={{
        id: 'p1', number: 42, title: 'Fix auth', state: 'merged', draft: false,
        author_login: 'sabari', additions: 10, deletions: 2,
        html_url: '#', merged_at: '2026-09-01T12:00:00Z',
      }}
      issueStatus="done"
      onMarkDone={vi.fn()}
    />)

    expect(screen.queryByRole('button', { name: /mark .* done/i })).toBeNull()
  })

  it('shows the diff size and merge state as evidence', () => {
    render(<EvidenceCard
      pr={{
        id: 'p1', number: 42, title: 'Fix auth', state: 'merged', draft: false,
        author_login: 'sabari', additions: 10, deletions: 2,
        html_url: '#', merged_at: '2026-09-01T12:00:00Z',
      }}
      issueStatus="done"
      onMarkDone={vi.fn()}
    />)

    expect(screen.getByText('+10')).toBeInTheDocument()
    expect(screen.getByText('-2')).toBeInTheDocument()
    expect(screen.getByText(/merged/i)).toBeInTheDocument()
  })
})

describe('EvidenceCard palette', () => {
  it('does not paint the diff size red or green: it is information, not judgement', () => {
    const { container } = render(
      <EvidenceCard
        pr={{
          id: 'p1', number: 42, title: 'Fix auth', state: 'merged', draft: false,
          author_login: 'sabari', additions: 88, deletions: 4,
          html_url: '#', merged_at: '2026-09-01T12:00:00Z',
        }}
        issueStatus="done"
        onMarkDone={vi.fn()}
      />,
    )
    const additions = screen.getByText('+88')
    const deletions = screen.getByText('-4')
    expect(additions.className).not.toMatch(/text-(done|blocked)/)
    expect(deletions.className).not.toMatch(/text-(done|blocked)/)
    // Red in particular is reserved for blocked or destructive.
    expect(container.querySelectorAll('.text-blocked')).toHaveLength(0)
  })
})
