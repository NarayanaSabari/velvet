import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Issue, Membership, Milestone, User } from '../../lib/types'
import { IssuesPage } from './IssuesPage'
import { membersQuery } from '../work/workLinks'
import { chooseOption, optionLabels } from '../../test-utils'

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
    const assigneeFilter = screen.getByTestId('issues-assignee-filter')
    expect(optionLabels(assigneeFilter)).toContain('Sabari')
    expect(assigneeFilter.getAttribute('data-option-values')).toContain(member.id)
    view.unmount()
    // A later detail-page observer must still read the envelope, not the
    // IssuesPage array projection. Fresh cache prevents a refetch hiding drift.
    expect(await client.fetchQuery({ ...membersQuery('lab'), staleTime: Infinity })).toEqual({ members: [member] })
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/w/lab/members')).toHaveLength(seeded ? 0 : 1)
  })

  it('loads only the requested page and replaces rows when paging back and forth', async () => {
    // The exact addresses below are the unfiltered ones, so this starts on all statuses.
    window.history.replaceState({}, '', '/w/lab/issues?status=all')
    const first = issue()
    const second = issue({ id: 'i2', key: 'ENG-2', number: 2, title: 'Filed work', milestone_id: 'm2' })
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === '/api/v1/me') return Promise.resolve(response({ user: member, memberships: [membership], last_workspace: membership }))
      if (input === '/api/v1/w/lab/members') return Promise.resolve(response({ members: [member] }))
      if (input === '/api/v1/w/lab/milestones') return Promise.resolve(response({ milestones: [milestone] }))
      if (input === '/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&group=status') return Promise.resolve(response({ issues: [first], next_cursor: 'next', matched_count: 2, total_count: 2 }))
      if (input === '/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&group=status&cursor=next') return Promise.resolve(response({ issues: [second], next_cursor: '', matched_count: 2, total_count: 2 }))
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
    expect(fetchMock).not.toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&group=status&cursor=next', expect.anything())
    await userEvent.setup().click(screen.getByRole('button', { name: /next page/i }))
    const filedRow = await screen.findByTestId('issue-row-i2')
    expect(screen.queryByTestId('issue-row-i1')).toBeNull()
    expect(filedRow).toHaveTextContent('Ship the Issues layout')
    expect(filedRow).not.toHaveTextContent('Filed to milestone')
    // One rule above the first row: the heading's, not a second one from the list.
    expect(screen.getByTestId('issues-list')).toHaveClass('divide-y', 'border-b')
    expect(screen.getByTestId('issues-list')).not.toHaveClass('border-y', 'border-t')
    expect(screen.getByText('Filed work')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&group=status', expect.anything())
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&group=status&cursor=next', expect.anything())
    expect(screen.getByRole('button', { name: /next page/i })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.setup().click(screen.getByRole('button', { name: /previous page/i }))
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
    // Astryx sizes the controls; each sits in Velvet's wrapper for the phone touch target.
    for (const testId of [
      'issues-search',
      'issues-status-filter',
      'issues-assignee-filter',
      'issues-priority-filter',
    ]) {
      expect(screen.getByTestId(testId).closest('.ui-field')).not.toBeNull()
    }
    expect(screen.getByTestId('issues-search').tagName).toBe('INPUT')
    expect(screen.getByTestId('issues-status-filter')).toHaveAttribute('role', 'combobox')
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
    expect(screen.getByTestId('issues-project-filter')).toHaveAttribute('data-value', 'demo')
    expect(screen.getByTestId('issues-status-filter')).toHaveAttribute('data-value', 'open')
    const initial = new URL(String(fetchMock.mock.calls.find(([path]) => String(path).includes('/issues?'))?.[0]), 'http://localhost')
    expect(initial.searchParams.getAll('status')).toEqual(['backlog', 'todo', 'in_progress', 'in_review'])
    await user.click(screen.getByTestId('issues-clear-filters'))
    await chooseOption(user, screen.getByTestId('issues-project-filter'), 'unfiled')
    await chooseOption(user, screen.getByTestId('issues-assignee-filter'), 'unassigned')
    await chooseOption(user, screen.getByTestId('issues-priority-filter'), '0')
    expect(await screen.findByText('Unassigned urgent work')).toBeInTheDocument()
    expect(screen.getByTestId('issues-count')).toHaveTextContent('1 of 3 issues')
    // Clearing returns to the open view, so the open statuses stay on the request.
    expect(screen.getByTestId('issues-status-filter')).toHaveAttribute('data-value', 'open')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&group=status&status=backlog&status=todo&status=in_progress&status=in_review&unassigned=true&priority=0&unfiled=true', expect.anything())
  })

  it('resets the cursor when filters change and never restores an old cursor when cleared', async () => {
    const fetchMock = setupFetch([])
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      if (!input.includes('/issues?')) return fallback(input, init)
      const params = new URL(input, 'http://localhost').searchParams
      // The resting view asks for every open status; a single status is a chosen filter.
      const filtered = params.getAll('status').length === 1
      const second = params.has('cursor')
      return Promise.resolve(response({ issues: [issue({ title: filtered ? 'Filtered' : second ? 'Second page' : 'First page' })], next_cursor: filtered || second ? '' : 'next', matched_count: filtered ? 1 : 2, total_count: 2 }))
    })
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('First page')
    await user.click(screen.getByRole('button', { name: /next page/i }))
    await screen.findByText('Second page')
    await chooseOption(user, screen.getByTestId('issues-status-filter'), 'todo')
    await screen.findByText('Filtered')
    const requestPaths = fetchMock.mock.calls.map(([path]) => String(path))
    // The open view also names todo, so match the todo-only request exactly.
    const todoOnly = (path: string) => new URL(path, 'http://localhost').searchParams.getAll('status').join() === 'todo'
    expect(requestPaths.some(todoOnly)).toBe(true)
    expect(requestPaths.some((path) => todoOnly(path) && path.includes('cursor='))).toBe(false)
    await user.click(screen.getByTestId('issues-clear-filters'))
    await screen.findByText('First page')
    expect(screen.getByRole('button', { name: /previous page/i })).toHaveAttribute('aria-disabled', 'true')
  })

  it('offers an off-page former assignee and retains the selection with no results', async () => {
    const fetchMock = setupFetch([])
    const fallback = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: string, init?: RequestInit) => input.includes('/issues?')
      ? Promise.resolve(response({ issues: [], next_cursor: '', total_count: 50, matched_count: 0, assignee_ids: ['former-member'] }))
      : fallback(input, init))
    const user = userEvent.setup()
    renderPage()
    await waitFor(() =>
      expect(optionLabels(screen.getByTestId('issues-assignee-filter'))).toContain('Assigned member (former-m)'))
    await chooseOption(user, screen.getByTestId('issues-assignee-filter'), 'former-member')
    await screen.findByTestId('issues-no-results')
    expect(screen.getByTestId('issues-assignee-filter')).toHaveAttribute('data-value', 'former-member')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=50&include_counts=true&fields=summary&group=status&status=backlog&status=todo&status=in_progress&status=in_review&assignee_id=former-member', expect.anything())
  })

  it('restores every filter from the address on load', async () => {
    window.history.replaceState({}, '', `/w/lab/issues?q=assigned&status=todo&assignee=${member.id}&priority=3&project=demo`)
    const fetchMock = setupFetch([issue({ id: 'a', title: 'Assigned todo', status: 'todo', priority: 3, assignee_id: member.id, project_id: 'p1' })])
    renderPage()
    expect(await screen.findByText('Assigned todo')).toBeInTheDocument()
    expect(screen.getByTestId('issues-search')).toHaveValue('assigned')
    expect(screen.getByTestId('issues-status-filter')).toHaveAttribute('data-value', 'todo')
    expect(screen.getByTestId('issues-assignee-filter')).toHaveAttribute('data-value', member.id)
    expect(screen.getByTestId('issues-priority-filter')).toHaveAttribute('data-value', '3')
    expect(screen.getByTestId('issues-project-filter')).toHaveAttribute('data-value', 'demo')
    const sent = new URL(String(fetchMock.mock.calls.find(([path]) => String(path).includes('/issues?'))?.[0]), 'http://localhost')
    expect(sent.searchParams.get('q')).toBe('assigned')
    expect(sent.searchParams.get('assignee_id')).toBe(member.id)
    expect(sent.searchParams.get('priority')).toBe('3')
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
    await chooseOption(user, screen.getByTestId('issues-status-filter'), 'todo')
    await chooseOption(user, screen.getByTestId('issues-assignee-filter'), member.id)
    await chooseOption(user, screen.getByTestId('issues-priority-filter'), '3')

    expect(await screen.findByText('Assigned todo')).toBeInTheDocument()
    expect(screen.queryByText('Done work')).toBeNull()
    expect(screen.getByTestId('issues-count')).toHaveTextContent('1 of 2 issues')
    expect(window.location.search).toBe(`?q=assigned&status=todo&assignee=${member.id}&priority=3`)

    await user.click(screen.getByTestId('issues-clear-filters'))
    expect(window.location.search).toBe('')
    expect(screen.getByTestId('issues-search')).toHaveValue('')
    expect(screen.getByTestId('issues-status-filter')).toHaveAttribute('data-value', 'open')
    expect(screen.getByTestId('issues-assignee-filter')).toHaveAttribute('data-value', '')
    expect(screen.getByTestId('issues-priority-filter')).toHaveAttribute('data-value', '')
    // Clearing returns to open work; finished work is one choice away.
    expect(await screen.findByText('Assigned todo')).toBeInTheDocument()
    expect(screen.queryByText('Done work')).toBeNull()
    await chooseOption(user, screen.getByTestId('issues-status-filter'), 'all')
    expect(await screen.findByText('Done work')).toBeInTheDocument()
    expect(window.location.search).toBe('?status=all')
  })

  it('creates an issue using the shared issue form and clears active filters', async () => {
    const fetchMock = setupFetch([issue({ status: 'todo', priority: 3, assignee_id: member.id })])
    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Unfiled audit')
    await chooseOption(user, screen.getByTestId('issues-status-filter'), 'todo')
    await chooseOption(user, screen.getByTestId('issues-assignee-filter'), member.id)
    await chooseOption(user, screen.getByTestId('issues-priority-filter'), '3')
    await user.click(screen.getByRole('button', { name: 'New issue' }))
    await user.type(screen.getByLabelText('Issue title'), 'New unfiled issue')
    await user.click(screen.getByRole('button', { name: 'Create issue' }))

    expect(await screen.findByText('New unfiled issue')).toBeInTheDocument()
    expect(screen.getByTestId('issues-status-filter')).toHaveAttribute('data-value', 'open')
    expect(screen.getByTestId('issues-assignee-filter')).toHaveAttribute('data-value', '')
    expect(screen.getByTestId('issues-priority-filter')).toHaveAttribute('data-value', '')
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

  it('opens on unfinished work and says how much is hidden', async () => {
    const fetchMock = setupFetch([
      issue({ id: 'todo', title: 'Still to do', status: 'todo' }),
      issue({ id: 'done', key: 'ENG-2', number: 2, title: 'Finished work', status: 'done' }),
      issue({ id: 'cancelled', key: 'ENG-3', number: 3, title: 'Dropped work', status: 'cancelled' }),
    ])
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('Still to do')).toBeInTheDocument()
    expect(screen.queryByText('Finished work')).toBeNull()
    expect(screen.queryByText('Dropped work')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Open issues' })).toBeInTheDocument()
    expect(screen.getByTestId('issues-count')).toHaveTextContent('1 of 3 issues')
    expect(window.location.search).toBe('')
    const first = new URL(String(fetchMock.mock.calls.find(([path]) => String(path).includes('/issues?'))?.[0]), 'http://localhost')
    expect(first.searchParams.getAll('status')).toEqual(['backlog', 'todo', 'in_progress', 'in_review'])
    // Nothing has been filtered yet, so there is nothing to clear.
    expect(screen.queryByTestId('issues-clear-filters')).toBeNull()

    await chooseOption(user, screen.getByTestId('issues-status-filter'), 'all')
    expect(await screen.findByText('Finished work')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'All issues' })).toBeInTheDocument()
    expect(screen.getByTestId('issues-count')).toHaveTextContent('3 issues')
    expect(screen.getByTestId('issues-clear-filters')).toBeInTheDocument()
  })

  it('keeps an address that names the open view outright', async () => {
    window.history.replaceState({}, '', '/w/lab/issues?project=demo&status=open')
    setupFetch([issue({ project_id: 'p1' })])
    renderPage()
    await screen.findByText('Unfiled audit')
    expect(window.location.search).toBe('?project=demo&status=open')
  })

  it('offers all issues when every issue is finished', async () => {
    setupFetch([issue({ status: 'done', title: 'Finished work' })])
    const user = userEvent.setup()
    renderPage()

    const empty = await screen.findByTestId('issues-no-results')
    expect(within(empty).getByText('No open issues')).toBeInTheDocument()
    await user.click(within(empty).getByRole('button', { name: 'Show all issues' }))
    expect(await screen.findByText('Finished work')).toBeInTheDocument()
  })

  it('names filters briefly on screen and in full for assistive technology', async () => {
    setupFetch([issue()])
    renderPage()
    await screen.findByText('Unfiled audit')
    const filters = within(screen.getByRole('region', { name: 'Issue filters' }))
    for (const [visible, name, testId] of [
      ['Search', 'Search issues', 'issues-search'],
      ['Status', 'Filter by status', 'issues-status-filter'],
      ['Assignee', 'Filter by assignee', 'issues-assignee-filter'],
      ['Project', 'Filter by project', 'issues-project-filter'],
      ['Priority', 'Filter by priority', 'issues-priority-filter'],
    ] as const) {
      expect(filters.getByText(visible, { exact: true })).toBeInTheDocument()
      expect(filters.getByLabelText(name)).toBe(screen.getByTestId(testId))
    }
  })

  it('keeps labels beside the title and the date on one line', async () => {
    setupFetch([issue({ labels: [{ id: 'l1', workspace_id: 'w1', name: 'backend', color: '#000' }] })])
    renderPage()
    const row = await screen.findByTestId('issue-row-i1')
    const title = within(row).getByTestId('issue-title-i1')
    const labels = within(row).getByTestId('issue-labels-i1')
    expect(labels).toHaveAccessibleName('Labels: backend')
    expect(title.parentElement).toBe(labels.parentElement)
    expect(within(row).getByTestId('issue-updated-i1')).toHaveClass('whitespace-nowrap')
  })

  it('shows an assignee more strongly than the word Unassigned', async () => {
    setupFetch([
      issue({ id: 'owned', title: 'Owned work', assignee_id: member.id }),
      issue({ id: 'free', key: 'ENG-2', number: 2, title: 'Free work', assignee_id: null }),
    ])
    renderPage()
    await screen.findByText('Owned work')
    expect(screen.getByTestId('issue-assignee-owned')).toHaveClass('text-grey-700')
    expect(screen.getByTestId('issue-assignee-free')).toHaveTextContent('Unassigned')
    expect(screen.getByTestId('issue-assignee-free')).not.toHaveClass('text-grey-700')
  })

  it('reads the list as status groups, in the order the server sends them', async () => {
    const fetchMock = setupFetch([
      issue({ id: 'a', title: 'Under way', status: 'in_progress' }),
      issue({ id: 'b', key: 'ENG-2', number: 2, title: 'Also under way', status: 'in_progress' }),
      issue({ id: 'c', key: 'ENG-3', number: 3, title: 'Queued', status: 'todo' }),
    ])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Under way')

    const sent = new URL(String(fetchMock.mock.calls.find(([path]) => String(path).includes('/issues?'))?.[0]), 'http://localhost')
    expect(sent.searchParams.get('group')).toBe('status')

    const list = screen.getByTestId('issues-list')
    expect(within(list).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['In progress', 'Todo'])
    const underWay = within(screen.getByTestId('issue-group-in_progress'))
    expect(underWay.getByRole('list', { name: /In progress/ })).toBeInTheDocument()
    expect(underWay.getByLabelText('2 in progress issues')).toBeInTheDocument()
    expect(underWay.getByText('Also under way')).toBeInTheDocument()
    expect(underWay.queryByText('Queued')).toBeNull()

    // Under a heading the row drops its badge, but still carries the status in words.
    expect(screen.getByTestId('issue-status-a')).toHaveClass('sr-only')
    expect(screen.getByTestId('issue-status-a')).toHaveTextContent('In progress')
    expect(within(screen.getByTestId('issue-row-a')).getByRole('link')).toHaveAccessibleName(/In progress/)

    // One chosen status needs no heading repeating it, so its rows keep the badge.
    await chooseOption(user, screen.getByTestId('issues-status-filter'), 'todo')
    await screen.findByText('Queued')
    await waitFor(() => expect(screen.queryByText('Under way')).toBeNull())
    expect(within(screen.getByTestId('issues-list')).queryByRole('heading', { level: 3 })).toBeNull()
    expect(screen.getByTestId('issue-status-c')).not.toHaveClass('sr-only')
  })

  it('leaves group counts off when the list continues on another page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/v1/me') return Promise.resolve(response({ user: member, memberships: [membership], last_workspace: membership }))
      if (input === '/api/v1/w/lab/members') return Promise.resolve(response({ members: [member] }))
      if (input.includes('/issues?')) return Promise.resolve(response({ issues: [issue({ status: 'todo' })], next_cursor: 'next', matched_count: 80, total_count: 80 }))
      return Promise.resolve(response({}))
    }))
    renderPage()
    await screen.findByText('Unfiled audit')
    expect(within(screen.getByTestId('issue-group-todo')).getByRole('heading', { level: 3 })).toHaveTextContent(/^Todo$/)
  })
})
