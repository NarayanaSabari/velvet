import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { StaleTable } from './Reports'

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
})
