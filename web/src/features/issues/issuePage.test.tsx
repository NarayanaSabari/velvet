import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { IssueEvidenceSection, IssuePageLayout, IssueTimeline } from './IssuePage'
import { EvidenceCard } from '../evidence/EvidenceCard'
import { StatusSelect } from './StatusSelect'

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

describe('IssuePageLayout', () => {
  it('keeps the narrative main column before the metadata rail', () => {
    render(
      <IssuePageLayout
        main={<p>Issue narrative</p>}
        sidebar={<p>Issue metadata</p>}
      />,
    )

    const columns = screen.getByTestId('issue-page-columns')
    expect(columns).toHaveClass('grid')
    expect(screen.getByTestId('issue-main')).toHaveTextContent('Issue narrative')
    expect(screen.getByTestId('issue-sidebar')).toHaveTextContent('Issue metadata')
    expect(columns.firstElementChild).toBe(screen.getByTestId('issue-main'))
    expect(columns.lastElementChild).toBe(screen.getByTestId('issue-sidebar'))
  })
})

describe('StatusSelect', () => {
  it('moves with arrows and commits the active option with Enter', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<StatusSelect value="backlog" onChange={onChange} />)

    const trigger = screen.getByTestId('status-listbox')
    await user.click(trigger)
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await user.keyboard('{ArrowDown}')
    expect(trigger).toHaveAttribute('aria-activedescendant', expect.stringContaining('-todo'))
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith('todo')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes with Escape without changing the selection', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<StatusSelect value="in_progress" onChange={onChange} />)

    const trigger = screen.getByTestId('status-listbox')
    await user.click(trigger)
    await user.keyboard('{ArrowDown}{Escape}')

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('IssueEvidenceSection', () => {
  it('always renders an actionable empty linked-PR state without a status control', () => {
    render(
      <IssueEvidenceSection
        issueStatus="in_progress"
        evidence={{ pull_requests: [], reviews: [], commits: [] }}
      />,
    )

    expect(screen.getByTestId('issue-evidence-section')).toBeInTheDocument()
    expect(screen.getByText('No linked PRs.')).toBeInTheDocument()
    expect(screen.getByText('Branch as sabari/eng-42-... to link automatically.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /mark issue done/i })).toBeNull()
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

  it('presents an open PR state as user-facing copy', () => {
    render(<EvidenceCard
      pr={{
        id: 'p1', number: 42, title: 'Fix auth', state: 'open', draft: false,
        author_login: 'sabari', additions: 10, deletions: 2,
        html_url: '#', merged_at: null,
      }}
      issueStatus="in_progress"
    />)

    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.queryByText('open', { exact: true })).toBeNull()
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
