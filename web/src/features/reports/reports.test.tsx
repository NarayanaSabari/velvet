import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { MilestoneCompletionTable, MilestoneCompletionTrend, StaleTable } from './Reports'
import type { MilestoneCompletionRow } from '../../lib/types'

const sprint = (overrides: Partial<MilestoneCompletionRow>): MilestoneCompletionRow => ({
  sprint_id: overrides.sprint_name ?? 's',
  sprint_name: 'Sprint',
  project_name: 'Portal',
  starts_on: '2026-01-01',
  state: 'completed',
  planned: 4,
  completed: 2,
  ...overrides,
})

// Deliberately out of order, as the API returns newest first across projects.
const completionRows = [
  sprint({ sprint_name: 'Portal 3', starts_on: '2026-03-01', state: 'upcoming', planned: 1, completed: 0 }),
  sprint({ sprint_name: 'Mobile 1', project_name: 'Mobile', starts_on: '2026-02-01', state: 'active', planned: 2, completed: 1 }),
  sprint({ sprint_name: 'Portal 2', starts_on: '2026-02-01', planned: 4, completed: 3 }),
  sprint({ sprint_name: 'Portal 1', starts_on: '2026-01-01', planned: 4, completed: 2 }),
]

describe('MilestoneCompletionTrend', () => {
  it('draws nothing when there are no sprints', () => {
    const { container } = render(<MilestoneCompletionTrend rows={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('groups sprints by project, oldest first', () => {
    render(<MilestoneCompletionTrend rows={completionRows} />)
    const panels = screen.getAllByRole('figure')
    expect(panels.map((panel) => panel.querySelector('figcaption')?.textContent)).toEqual(['Mobile', 'Portal'])
    const names = [...(panels[1]?.querySelectorAll('li') ?? [])]
      .map((li) => (li.getAttribute('title') ?? '').replace(/\s*[:(].*$/, ''))
    expect(names).toEqual(['Portal 1', 'Portal 2', 'Portal 3'])
  })

  it('describes a closed sprint by its rate in words', () => {
    render(<MilestoneCompletionTrend rows={completionRows} />)
    expect(screen.getByText('Portal 2: 3 of 4 milestones completed, 75%')).toHaveClass('sr-only')
  })

  it('names an unfinished sprint instead of giving it a failing rate', () => {
    render(<MilestoneCompletionTrend rows={completionRows} />)
    expect(screen.getByText('Mobile 1 (active): 1 of 2 milestones completed so far')).toBeInTheDocument()
    expect(screen.getByText('Portal 3 (upcoming): 0 of 1 milestones completed so far')).toBeInTheDocument()
    // Neither open sprint shows a percentage: Portal 3 would be 0%, Mobile 1 50%.
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    expect(document.querySelector('li[title^="Mobile 1"]')).not.toHaveTextContent('%')
  })

  it('treats a sprint with no state as closed, for servers that do not send one', () => {
    render(<MilestoneCompletionTrend rows={[sprint({ sprint_name: 'Old', state: undefined, planned: 2, completed: 0 })]} />)
    expect(screen.getByText('Old: 0 of 2 milestones completed, 0%')).toBeInTheDocument()
  })

  it('keeps only the latest sprints per project', () => {
    const many = Array.from({ length: 10 }, (_, n) =>
      sprint({ sprint_name: `S${n}`, starts_on: `2026-01-${String(n + 1).padStart(2, '0')}` }))
    render(<MilestoneCompletionTrend rows={many} />)
    const shown = [...screen.getByRole('figure').querySelectorAll('li')]
    expect(shown).toHaveLength(8)
    expect(shown.at(0)).toHaveAttribute('title', expect.stringMatching(/^S2:/))
  })
})

describe('MilestoneCompletionTable', () => {
  const cells = () => screen.getAllByRole('row').slice(1)
    .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))

  it('reads in the same order as the chart', () => {
    render(<MilestoneCompletionTable rows={completionRows} />)
    expect(cells().map((row) => row[0])).toEqual(['Mobile 1', 'Portal 1', 'Portal 2', 'Portal 3'])
  })

  it('uses the same words as the chart for sprints that have not closed', () => {
    render(<MilestoneCompletionTable rows={completionRows} />)
    expect(cells().map((row) => row[4])).toEqual(['Active', '50%', '75%', 'Upcoming'])
  })

  it('shows a dash when nothing was planned', () => {
    render(<MilestoneCompletionTable rows={[sprint({ planned: 0, completed: 0 })]} />)
    expect(cells().map((row) => row[4])).toEqual(['—'])
  })
})

describe('StaleTable', () => {
	it('shows an email-only assignee', () => {
		render(<StaleTable rows={[
			{ id: 'i-email', key: 'ENG-2', title: 'Email-owned work', status: 'in_progress', days_silent: 21, assignee_name: 'Member', assignee_email: 'member@example.com', assignee_login: null },
		]} />)

		expect(screen.getByText('Member')).toBeInTheDocument()
	})

  it('says how long each issue has been silent', () => {
    render(<StaleTable rows={[
      { id: 'i1', key: 'ENG-1', title: 'Stuck thing', status: 'in_progress', days_silent: 21, assignee_login: 'sabari' },
    ]} />)

    expect(screen.getByText('ENG-1')).toBeInTheDocument()
    expect(screen.getByText(/21 days/)).toBeInTheDocument()
  })

  it('says so plainly when nothing is stale', () => {
    render(<StaleTable rows={[]} />)
    expect(screen.getByText(/nothing has stalled/i)).toBeInTheDocument()
  })

  it('gives the table a named, focusable scroll region with a phone-only hint', () => {
    render(<StaleTable rows={[
      { id: 'i1', key: 'ENG-1', title: 'Stuck thing', status: 'in_progress', days_silent: 21, assignee_login: 'sabari' },
    ]} />)

    expect(screen.getByRole('region', { name: 'Stale work' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByText('Scroll sideways to see every column.')).toHaveClass('sm:hidden')
  })
})
