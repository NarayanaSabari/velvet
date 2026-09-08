import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAppRouter } from './router'

describe('public auth routes', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('shows check-email without requiring a session', async () => {
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'unauthenticated', message: 'sign-in required' } }),
    } as Response))
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/check-email'] }))

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /sign in with github/i })).toBeNull()
  })
})

const first = { id: 'm1', workspace_id: 'w1', workspace_slug: 'first', workspace_name: 'First', role: 'member' }
const last = { id: 'm2', workspace_id: 'w2', workspace_slug: 'last', workspace_name: 'Last', role: 'viewer' }
function show(path: string, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  vi.stubGlobal('scrollTo', vi.fn())
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }), client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

it.each([
  ['/signin', 'Work log'], ['/expired', 'Link expired'], ['/signin/confirm', 'Link expired'], ['/invite', 'Link expired'],
])('renders public %s without fetching a session', async (path, heading) => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  show(path)
  expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
})

it.each([
  { memberships: [], last_workspace: null, path: '/orgs/new' },
  { memberships: [first, last], last_workspace: last, path: '/w/last' },
  { memberships: [first], last_workspace: last, path: '/w/first' },
  { memberships: [first, last], last_workspace: { ...last, workspace_slug: 'stale', role: 'admin' }, path: '/w/last' },
])('lands at $path using current memberships', async ({ memberships, last_workspace, path }) => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, status: 200, json: async () => url === '/api/v1/me'
    ? { user: { id: 'u1', email: 'person@example.com', github_login: null, name: '', avatar_url: '' }, memberships, last_workspace }
    : { invites: [], my_issues: [], active_sprint: null, milestones: [], recent_activity: [], unread_mentions: 0 } } as Response)))
  const router = show('/')
  await waitFor(() => expect(router.state.location.pathname).toBe(path))
})

it('sends a signed-out root visitor to sign-in', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'unauthenticated', message: 'sign-in required' } }) } as Response))
  const router = show('/')
  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'))
})

it('protects the organisation creation page', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'unauthenticated', message: 'sign-in required' } }) } as Response))
  show('/orgs/new')
  expect(await screen.findByRole('button', { name: 'Send sign-in link' })).toBeInTheDocument()
  expect(screen.queryByLabelText('Organisation name')).not.toBeInTheDocument()
})

it('refreshes a stale session and clears old identity projections before rendering the current account', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['session'], { user: { id: 'old', email: 'old@example.com', name: '', github_login: null, avatar_url: '' }, memberships: [first], last_workspace: first })
  client.setQueryData(['feed', 'first'], ['old account private data'])
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, status: 200, json: async () => url === '/api/v1/me'
    ? { user: { id: 'new', email: 'new@example.com', name: '', github_login: null, avatar_url: '' }, memberships: [last], last_workspace: last }
    : { my_issues: [], active_sprint: null, milestones: [], recent_activity: [], unread_mentions: 0 } } as Response)))
  show('/', client)
  expect(await screen.findByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/w/last/settings/profile')
  expect(client.getQueryData(['feed', 'first'])).toBeUndefined()
  expect(screen.getByText('new@example.com')).toBeInTheDocument()
})
