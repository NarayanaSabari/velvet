import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SprintList } from './SprintList'
import { isBehind, issueWork, issuesInSprint, milestoneWork, sprintPace } from './sprintDays'

const membership = { id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role: 'admin' }
const projects = [
  { id: 'p-web', key: 'web', name: 'Web app', status: 'active' },
  { id: 'p-api', key: 'api', name: 'API', status: 'active' },
]
const sprints = [
  { id: 's1', project_id: 'p-web', name: 'Web 1', starts_on: '2026-10-05', ends_on: '2026-10-18', state: 'completed' },
  { id: 's2', project_id: 'p-web', name: 'Web 2', starts_on: '2026-10-19', ends_on: '2026-11-01', state: 'active' },
  { id: 's3', project_id: 'p-web', name: 'Web 3', starts_on: '2026-11-02', ends_on: '2026-11-15', state: 'upcoming' },
  { id: 's4', project_id: 'p-api', name: 'API Q4', starts_on: '2026-10-01', ends_on: '2026-11-11', state: 'completed' },
]
const dashboard = {
  activity: [], my_issues: [], unread_mentions: 0, active_sprint: null, milestones: [],
  active_sprints: [{
    sprint: sprints[1], project_key: 'web', project_name: 'Web app',
    milestones: [
      { id: 'm-1', name: 'Checkout', issue_counts: { done: 2, todo: 3 } },
      { id: 'm-2', name: 'Receipts', issue_counts: {} },
    ],
  }],
}

function show(dashboardFails = false) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
    const url = String(input)
    const body = url === '/api/v1/me' ? { user: { id: 'u1', name: 'Ada', email: 'ada@example.test', github_login: null, avatar_url: '' }, memberships: [membership], last_workspace: membership }
      : url.endsWith('/sprints') ? { sprints }
      : url.endsWith('/dashboard') ? dashboard
      : { projects }
    const failed = dashboardFails && url.endsWith('/dashboard')
    return Promise.resolve({ ok: !failed, status: failed ? 500 : 200, json: async () => (failed ? { error: { code: 'internal', message: 'no' } } : body) } as Response)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><SprintList slug="lab" /></QueryClientProvider>)
}

beforeEach(() => vi.unstubAllGlobals())

describe('isBehind', () => {
  it('says nothing in the first half, or when a sprint has no issues', () => {
    expect(isBehind({ day: 6, length: 14, done: 0, total: 9 })).toBe(false)
    expect(isBehind({ day: 12, length: 14, done: 0, total: 0 })).toBe(false)
  })

  it('flags finished work that trails the calendar by 25 points or more', () => {
    // 57% of the days gone, 11% of the issues done.
    expect(isBehind({ day: 8, length: 14, done: 1, total: 9 })).toBe(true)
    // 57% gone, 33% done: 24 points under, so not flagged.
    expect(isBehind({ day: 8, length: 14, done: 1, total: 3 })).toBe(false)
    expect(isBehind({ day: 14, length: 14, done: 8, total: 10 })).toBe(false)
  })
})

describe('sprintPace', () => {
  const sprint = { id: 's', workspace_id: 'w', project_id: 'p', name: 'Long ago', starts_on: '2020-01-06', ends_on: '2020-01-19', created_at: '', completed_at: null }
  const milestones = [
    { issue_counts: { done: 1, todo: 3 } },
    { issue_counts: { in_progress: 2 } },
    { issue_counts: {} },
  ] as never

  it('adds up the issues under the milestones and reads the pace from them', () => {
    // Its dates are long past, so all of its time has gone.
    const pace = sprintPace({ ...sprint, state: 'active' }, milestoneWork(milestones))
    expect(pace).toMatchObject({ done: 1, total: 6, day: 14, length: 14, timeGone: 100, behind: true })
  })

  it('only calls a running sprint behind', () => {
    expect(sprintPace({ ...sprint, state: 'completed' }, milestoneWork(milestones)).behind).toBe(false)
  })

  it('counts issues without a milestone for their project, and leaves cancelled work out', () => {
    const all = [
      { id: 'a', milestone_id: 'm-1', project_id: 'p', status: 'done' },
      { id: 'b', milestone_id: 'm-1', project_id: 'p', status: 'todo' },
      { id: 'c', milestone_id: null, project_id: 'p', status: 'in_progress' },
      { id: 'd', milestone_id: null, project_id: 'p', status: 'cancelled' },
      // Another sprint's milestone, and another project's unfiled work.
      { id: 'e', milestone_id: 'm-9', project_id: 'p', status: 'done' },
      { id: 'f', milestone_id: null, project_id: 'other', status: 'done' },
    ] as never
    const mine = issuesInSprint({ ...sprint, state: 'active' }, [{ id: 'm-1' }] as never, all)
    expect(mine.map((issue) => issue.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(issueWork(mine)).toEqual({ done: 1, total: 3 })
  })
})

describe('SprintList', () => {
  it('draws each project as a row of sprint links on a shared calendar, oldest first', async () => {
    show()
    const web = await screen.findByTestId('sprint-project-web')
    expect(within(web).getByRole('heading', { level: 2, name: 'Web app' })).toBeInTheDocument()
    const links = within(web).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/w/lab/sprints/s1', '/w/lab/sprints/s2', '/w/lab/sprints/s3'])
    // The dates and state are read out with the name, not left to the bar's place and fill.
    expect(links[1]).toHaveTextContent('Web 2, 19 Oct 2026 to 1 Nov 2026, Active')
    expect(screen.getByRole('list', { name: 'What the bars mean' })).toHaveTextContent('Upcoming')
  })

  it('summarises the running sprint of each project, with its milestones and what is next', async () => {
    show()
    const web = await screen.findByTestId('running-sprint-web')
    expect(within(web).getByRole('link', { name: 'Web 2' })).toHaveAttribute('href', '/w/lab/sprints/s2')
    expect(within(web).getByRole('progressbar')).toHaveAttribute('aria-valuemax', '14')
    expect(await within(web).findByRole('link', { name: /Checkout/ })).toHaveAttribute('href', '/w/lab/milestones/m-1')
    expect(within(web).getByLabelText('2 of 5 issues done')).toHaveTextContent('2/5')
    // A milestone with nothing filed under it says so, not "0/0".
    expect(within(web).getByRole('link', { name: /Receipts/ }).closest('li')).toHaveTextContent('No issues yet')
    expect(within(web).queryByText('0/0')).toBeNull()
    expect(within(web).getByText(/Next: Web 3/)).toBeInTheDocument()
    // A project between sprints says so instead of leaving a gap.
    expect(within(screen.getByTestId('running-sprint-api')).getByRole('heading', { name: 'No sprint running' })).toBeInTheDocument()
  })

  it('still shows running sprints when their milestones cannot be loaded', async () => {
    show(true)
    const web = await screen.findByTestId('running-sprint-web')
    expect(within(web).getByRole('link', { name: 'Web 2' })).toBeInTheDocument()
    expect(within(web).queryByRole('list')).toBeNull()
  })
})
