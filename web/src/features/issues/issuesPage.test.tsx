import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Issue, Membership, Milestone, User } from '../../lib/types'
import { IssuesPage } from './IssuesPage'

const member: User = {
  id: 'u1',
  email: 'sabari@example.test',
  github_login: 'sabari',
  name: 'Sabari',
  avatar_url: '',
}
const membership: Membership = {
  id: 'm1',
  workspace_id: 'w1',
  workspace_slug: 'lab',
  workspace_name: 'Lab',
  issue_prefix: 'ENG',
  role: 'admin',
}
const milestone: Milestone = {
  id: 'm2',
  workspace_id: 'w1',
  sprint_id: 's1',
  name: 'Ship the Issues layout',
  description: '',
  owner_id: null,
  target_date: null,
  status: 'planned',
  position: 'a',
  created_at: '',
  updated_at: '',
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    workspace_id: 'w1',
    key: 'ENG-1',
    number: 1,
    title: 'Unfiled audit',
    description: 'Review the accessibility checklist',
    status: 'backlog',
    priority: 1,
    assignee_id: null,
    milestone_id: null,
    parent_id: null,
    position: 'a',
    created_by: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function setupFetch(initialIssues: Issue[]) {
  let issues = [...initialIssues]
  const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
    if (input === '/api/v1/me') {
      return Promise.resolve(response({ user: member, memberships: [membership], last_workspace: membership }))
    }
    if (input === '/api/v1/w/lab/members') {
      return Promise.resolve(response({ members: [member] }))
    }
    if (input === '/api/v1/w/lab/milestones') {
      return Promise.resolve(response({ milestones: [milestone] }))
    }
    if (input.startsWith('/api/v1/w/lab/issues')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { title: string }
        const created = issue({
          id: `created-${issues.length + 1}`,
          key: `ENG-${issues.length + 1}`,
          number: issues.length + 1,
          title: body.title,
          position: String.fromCharCode(97 + issues.length),
        })
        issues = [...issues, created]
        return Promise.resolve(response(created, 201))
      }
      return Promise.resolve(response({ issues, next_cursor: '' }))
    }
    return Promise.resolve(response({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <IssuesPage slug="lab" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/w/lab/issues')
})

describe('IssuesPage', () => {
  it('walks pagination and renders unfiled issue links', async () => {
    const first = issue()
    const second = issue({ id: 'i2', key: 'ENG-2', number: 2, title: 'Filed work', milestone_id: 'm2' })
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === '/api/v1/me') return Promise.resolve(response({ user: member, memberships: [membership], last_workspace: membership }))
      if (input === '/api/v1/w/lab/members') return Promise.resolve(response({ members: [member] }))
      if (input === '/api/v1/w/lab/milestones') return Promise.resolve(response({ milestones: [milestone] }))
      if (input === '/api/v1/w/lab/issues?limit=200') return Promise.resolve(response({ issues: [first], next_cursor: 'next' }))
      if (input === '/api/v1/w/lab/issues?limit=200&cursor=next') return Promise.resolve(response({ issues: [second], next_cursor: '' }))
      return Promise.resolve(response({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderPage()

    const row = await screen.findByTestId('issue-row-i1')
    expect(row).toHaveTextContent('Unfiled')
    expect(within(row).getByRole('link', { name: /ENG-1/ })).toHaveAttribute(
      'href',
      '/w/lab/issues/ENG-1',
    )
    const filedRow = screen.getByTestId('issue-row-i2')
    expect(filedRow).toHaveTextContent('Ship the Issues layout')
    expect(filedRow).not.toHaveTextContent('Filed to milestone')
    expect(screen.getByTestId('issues-list')).toHaveClass('divide-y', 'border-y')
    expect(screen.getByText('Filed work')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=200', expect.anything())
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=200&cursor=next', expect.anything())
  })

  it('filters by search, status, assignee, and priority, then clears them', async () => {
    const target = issue({
      id: 'target',
      key: 'ENG-2',
      number: 2,
      title: 'Assigned todo',
      status: 'todo',
      priority: 3,
      assignee_id: member.id,
      milestone_id: 'm2',
    })
    const other = issue({ id: 'other', key: 'ENG-3', number: 3, title: 'Done work', status: 'done', priority: 4 })
    const user = userEvent.setup()
    setupFetch([target, other])
    renderPage()

    await screen.findByText('Assigned todo')
    await user.clear(screen.getByTestId('issues-search'))
    await user.type(screen.getByTestId('issues-search'), 'assigned')
    await user.selectOptions(screen.getByTestId('issues-status-filter'), 'todo')
    await user.selectOptions(screen.getByTestId('issues-assignee-filter'), member.id)
    await user.selectOptions(screen.getByTestId('issues-priority-filter'), '3')

    expect(screen.getByText('Assigned todo')).toBeInTheDocument()
    expect(screen.queryByText('Done work')).toBeNull()
    expect(screen.getByTestId('issues-count')).toHaveTextContent('1 of 2 issues')

    await user.click(screen.getByTestId('issues-clear-filters'))
    expect(screen.getByTestId('issues-search')).toHaveValue('')
    expect(screen.getByTestId('issues-status-filter')).toHaveValue('')
    expect(screen.getByTestId('issues-assignee-filter')).toHaveValue('')
    expect(screen.getByTestId('issues-priority-filter')).toHaveValue('')
    expect(screen.getByText('Done work')).toBeInTheDocument()
  })

  it('creates an issue using the shared issue form and clears active filters', async () => {
    const fetchMock = setupFetch([issue({ status: 'todo', priority: 3, assignee_id: member.id })])
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Unfiled audit')
    await user.selectOptions(screen.getByTestId('issues-status-filter'), 'todo')
    await user.selectOptions(screen.getByTestId('issues-assignee-filter'), member.id)
    await user.selectOptions(screen.getByTestId('issues-priority-filter'), '3')
    await user.click(screen.getByRole('button', { name: 'New issue' }))
    await user.type(screen.getByLabelText('Issue title'), 'New unfiled issue')
    await user.click(screen.getByRole('button', { name: 'Create issue' }))

    expect(await screen.findByText('New unfiled issue')).toBeInTheDocument()
    expect(screen.getByTestId('issues-status-filter')).toHaveValue('')
    expect(screen.getByTestId('issues-assignee-filter')).toHaveValue('')
    expect(screen.getByTestId('issues-priority-filter')).toHaveValue('')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/w/lab/issues',
      expect.objectContaining({ method: 'POST' }),
    )
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'New issue' })).toBeNull())
  })

  it('shows a helpful empty, no-results, and error state', async () => {
    setupFetch([])
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByTestId('issues-empty')).toBeInTheDocument()

    cleanup()
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/v1/me') return Promise.resolve(response({ user: member, memberships: [membership], last_workspace: membership }))
      if (input === '/api/v1/w/lab/members') return Promise.resolve(response({ members: [member] }))
      return Promise.resolve(response({ error: { code: 'internal', message: 'failed' } }, 500))
    }))
    window.history.replaceState({}, '', '/w/lab/issues')
    renderPage()
    expect(await screen.findByTestId('issues-error')).toBeInTheDocument()

    cleanup()
    vi.unstubAllGlobals()
    setupFetch([issue()])
    window.history.replaceState({}, '', '/w/lab/issues')
    renderPage()
    await screen.findByText('Unfiled audit')
    await user.clear(screen.getByTestId('issues-search'))
    await user.type(screen.getByTestId('issues-search'), 'does not exist')
    expect(await screen.findByTestId('issues-no-results')).toBeInTheDocument()
  })
})
