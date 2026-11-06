import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Issue, Membership, Milestone, User } from '../../lib/types'
import { IssuesPage } from './IssuesPage'
import { membersQuery } from '../work/workLinks'

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
    project_id: null,
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
    if (input.startsWith('/api/v1/w/lab/projects')) {
      return Promise.resolve(response({ projects: [{ id: 'p1', key: 'demo', name: 'Demo', status: 'active' }] }))
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
      const params = new URL(input, 'http://localhost').searchParams
      const filtered = issues.filter((item) => {
        const q = (params.get('q') ?? '').toLowerCase()
        return [item.key, item.title, item.description].some((value) => value.toLowerCase().includes(q))
          && (!params.has('status') || params.getAll('status').includes(item.status))
          && (!params.has('assignee_id') || item.assignee_id === params.get('assignee_id'))
          && (!params.has('unassigned') || item.assignee_id === null)
          && (!params.has('unfiled') || item.project_id === null)
          && (!params.has('project') || (params.get('project') === 'demo' && item.project_id === 'p1'))
          && (!params.has('priority') || item.priority === Number(params.get('priority')))
      })
      return Promise.resolve(response({ issues: filtered, next_cursor: '', matched_count: filtered.length, total_count: issues.length }))
    }
    return Promise.resolve(response({}))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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
  it('shows labels and relative age on each row', async () => {
    const stale = new Date(Date.now() - 3 * 86400 * 1000).toISOString()
    setupFetch([
      issue({
        updated_at: stale,
        labels: [{ id: 'l1', workspace_id: 'w1', name: 'bug', color: '#111111' }],
      }),
    ])
    renderPage(new QueryClient({ defaultOptions: { queries: { retry: false } } }))
    expect(await screen.findByTestId('issue-labels-i1')).toHaveTextContent('bug')
    expect(screen.getByTestId('issue-labels-i1')).toHaveAttribute('aria-label', 'Labels: bug')
    expect(screen.getByTestId('issue-updated-i1')).toHaveTextContent('3 days ago')
  })

  it.each([false, true])('preserves the canonical members cache before and after list navigation (seeded: %s)', async (seeded) => {
    const fetchMock = setupFetch([issue({ assignee_id: member.id })])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    // Detail, milestone and sprint pages all cache the API response envelope.
    if (seeded) client.setQueryData(membersQuery('lab').queryKey, { members: [member] })
    const view = renderPage(client)
    expect(await screen.findByTestId('issue-assignee-i1')).toHaveTextContent('Sabari')
    expect(screen.getByRole('option', { name: 'Sabari' })).toHaveValue(member.id)
    view.unmount()
    // A later detail-page observer must still read the envelope, not the
    // IssuesPage array projection. Fresh cache prevents a refetch hiding drift.
    expect(await client.fetchQuery({ ...membersQuery('lab'), staleTime: Infinity })).toEqual({ members: [member] })
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/w/lab/members')).toHaveLength(seeded ? 0 : 1)
  })

  it('loads only the requested page and replaces rows when paging back and forth', async () => {
    const first = issue()
    const second = issue({ id: 'i2', key: 'ENG-2', number: 2, title: 'Filed work', milestone_id: 'm2' })
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === '/api/v1/me') return Promise.resolve(response({ user: member, memberships: [membership], last_workspace: membership }))
      if (input === '/api/v1/w/lab/members') return Promise.resolve(response({ members: [member] }))
      if (input === '/api/v1/w/lab/milestones') return Promise.resolve(response({ milestones: [milestone] }))
      if (input === '/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary') return Promise.resolve(response({ issues: [first], next_cursor: 'next', matched_count: 2, total_count: 2 }))
      if (input === '/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&cursor=next') return Promise.resolve(response({ issues: [second], next_cursor: '', matched_count: 2, total_count: 2 }))
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
    expect(screen.queryByTestId('issue-row-i2')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&cursor=next', expect.anything())
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next page' }))
    const filedRow = await screen.findByTestId('issue-row-i2')
    expect(screen.queryByTestId('issue-row-i1')).toBeNull()
    expect(filedRow).toHaveTextContent('Ship the Issues layout')
    expect(filedRow).not.toHaveTextContent('Filed to milestone')
    expect(screen.getByTestId('issues-list')).toHaveClass('divide-y', 'border-y')
    expect(screen.getByText('Filed work')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary', expect.anything())
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&cursor=next', expect.anything())
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous page' }))
    expect(await screen.findByTestId('issue-row-i1')).toBeInTheDocument()
    expect(screen.queryByTestId('issue-row-i2')).toBeNull()
  })

  it('uses the sibling page alignment and compact, labeled filter controls', async () => {
    setupFetch([issue()])
    renderPage()

    const page = await screen.findByTestId('issues-page')
    expect(page).toHaveClass('w-full', 'min-w-0')
    expect(page.className).not.toMatch(/max-w-/)
    expect(page).not.toHaveClass('mx-auto')
    expect(screen.queryByText('Workspace', { exact: true })).toBeNull()
    expect(screen.queryByText(/Every issue in/)).toBeNull()

    expect(screen.getByRole('region', { name: 'Issue filters' })).toBeInTheDocument()
    for (const testId of [
      'issues-search',
      'issues-status-filter',
      'issues-assignee-filter',
      'issues-priority-filter',
    ]) {
      expect(screen.getByTestId(testId)).toHaveClass('min-h-10', 'md:min-h-8')
    }
    expect(screen.getByLabelText('Search issues')).toBe(screen.getByTestId('issues-search'))
    expect(screen.getByLabelText('Filter by status')).toBe(screen.getByTestId('issues-status-filter'))
  })

  it('sends project open-count filters and supports unassigned, unfiled and priority zero', async () => {
    window.history.replaceState({}, '', '/w/lab/issues?project=demo&status=open')
    const fetchMock = setupFetch([
      issue({ id: 'open', title: 'Project open work', project_id: 'p1', status: 'todo' }),
      issue({ id: 'done', title: 'Project done work', project_id: 'p1', status: 'done' }),
      issue({ id: 'unfiled', title: 'Unassigned urgent work', priority: 0 }),
    ])
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByText('Project open work')).toBeInTheDocument()
    expect(screen.queryByText('Project done work')).toBeNull()
    expect(screen.getByTestId('issues-count')).toHaveTextContent('1 of 3 issues')
    expect(screen.getByTestId('issues-project-filter')).toHaveValue('demo')
    expect(screen.getByTestId('issues-status-filter')).toHaveValue('open')
    const initial = new URL(String(fetchMock.mock.calls.find(([path]) => String(path).includes('/issues?'))?.[0]), 'http://localhost')
    expect(initial.searchParams.getAll('status')).toEqual(['backlog', 'todo', 'in_progress', 'in_review'])
    await user.click(screen.getByTestId('issues-clear-filters'))
    await user.selectOptions(screen.getByTestId('issues-project-filter'), 'unfiled')
    await user.selectOptions(screen.getByTestId('issues-assignee-filter'), 'unassigned')
    await user.selectOptions(screen.getByTestId('issues-priority-filter'), '0')
    expect(await screen.findByText('Unassigned urgent work')).toBeInTheDocument()
    expect(screen.getByTestId('issues-count')).toHaveTextContent('1 of 3 issues')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&unassigned=true&priority=0&unfiled=true', expect.anything())
  })

  it('resets the cursor when filters change and never restores an old cursor when cleared', async () => {
    const fetchMock = setupFetch([])
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (!input.includes('/issues?')) return fallback(input, init)
      const params = new URL(input, 'http://localhost').searchParams
      const filtered = params.has('status')
      const second = params.has('cursor')
      return Promise.resolve(response({ issues: [issue({ title: filtered ? 'Filtered' : second ? 'Second page' : 'First page' })], next_cursor: filtered || second ? '' : 'next', matched_count: filtered ? 1 : 2, total_count: 2 }))
    })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('First page')
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('Second page')
    await user.selectOptions(screen.getByTestId('issues-status-filter'), 'todo')
    await screen.findByText('Filtered')
    const requestPaths = fetchMock.mock.calls.map(([path]) => String(path))
    expect(requestPaths.some((path) => path.includes('status=todo') && path.includes('cursor='))).toBe(false)
    await user.click(screen.getByTestId('issues-clear-filters'))
    await screen.findByText('First page')
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
  })

  it('offers an off-page former assignee and retains the selection with no results', async () => {
    const fetchMock = setupFetch([])
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: string, init?: RequestInit) => input.includes('/issues?')
      ? Promise.resolve(response({ issues: [], next_cursor: '', total_count: 50, matched_count: 0, assignee_ids: ['former-member'] }))
      : fallback(input, init))
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('option', { name: 'Assigned member (former-m)' })
    await user.selectOptions(screen.getByTestId('issues-assignee-filter'), 'former-member')
    await screen.findByTestId('issues-no-results')
    expect(screen.getByTestId('issues-assignee-filter')).toHaveValue('former-member')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&assignee_id=former-member', expect.anything())
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
      project_id: null,
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

    expect(await screen.findByText('Assigned todo')).toBeInTheDocument()
    expect(screen.queryByText('Done work')).toBeNull()
    expect(screen.getByTestId('issues-count')).toHaveTextContent('1 of 2 issues')

    await user.click(screen.getByTestId('issues-clear-filters'))
    expect(screen.getByTestId('issues-search')).toHaveValue('')
    expect(screen.getByTestId('issues-status-filter')).toHaveValue('')
    expect(screen.getByTestId('issues-assignee-filter')).toHaveValue('')
    expect(screen.getByTestId('issues-priority-filter')).toHaveValue('')
    expect(await screen.findByText('Done work')).toBeInTheDocument()
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
