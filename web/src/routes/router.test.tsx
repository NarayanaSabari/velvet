import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

    expect(await screen.findByRole('heading', { name: 'Check your email', level: 1 })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.queryByRole('link', { name: /sign in with github/i })).toBeNull()
  })
})

const first = { id: 'm1', workspace_id: 'w1', workspace_slug: 'first', workspace_name: 'First', issue_prefix: 'ONE', role: 'member' }
const last = { id: 'm2', workspace_id: 'w2', workspace_slug: 'last', workspace_name: 'Last', issue_prefix: 'TWO', role: 'viewer' }
function show(path: string, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  vi.stubGlobal('scrollTo', vi.fn())
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }), client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

it.each([
  ['/signin', 'Sign in to Velvet'], ['/expired', 'Link expired'], ['/signin/confirm', 'Link expired'], ['/invite', 'Link expired'],
])('renders public %s without fetching a session', async (path, heading) => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  show(path)
  expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument()
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
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

it('shows the public landing page to a signed-out root visitor', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'unauthenticated', message: 'sign-in required' } }) } as Response))
  const router = show('/')

  await waitFor(() => expect(router.state.matches.every((match) => match.status === 'success')).toBe(true))
  expect(screen.getByRole('heading', { name: 'Know what you worked on last week.' })).toBeInTheDocument()
  expect(router.state.location.pathname).toBe('/')
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

it('keeps the public frame visible while the root session check is pending', async () => {
  let resolveSession!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveSession = resolve })))
  show('/')

  expect(await screen.findByRole('status')).toHaveTextContent('Checking your session')
  expect(screen.getByRole('navigation', { name: 'Public navigation' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin')
  expect(document.title).toBe('Opening Velvet · Velvet')

  await act(async () => resolveSession({ ok: false, status: 401, json: async () => ({ error: { code: 'unauthenticated', message: 'sign-in required' } }) } as Response))
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
})

it('retries a failed root session check and clears the route error', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { code: 'unavailable', message: 'internal service detail' } }) } as Response)
    .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: { code: 'unauthenticated', message: 'sign-in required' } }) } as Response)
  vi.stubGlobal('fetch', fetchMock)
  const router = show('/')

  expect(await screen.findByRole('heading', { name: 'Unable to open Velvet' })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('We could not check your session')
  expect(screen.queryByText('internal service detail')).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await waitFor(() => expect(router.state.matches.every((match) => match.status === 'success' && !match.error)).toBe(true))
  expect(screen.getByRole('heading', { name: 'Know what you worked on last week.' })).toBeInTheDocument()
})

it('offers safe recovery links without fetching or replaying a GitHub callback', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  show('/auth/recovery')

  expect(await screen.findByRole('heading', { name: 'Could not connect GitHub' })).toBeInTheDocument()
  expect(screen.getByText(/start a new connection from your profile or organisation settings/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Return to Velvet' })).toHaveAttribute('href', '/')
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin')
  expect(fetchMock).not.toHaveBeenCalled()
  expect(document.title).toBe('Could not connect GitHub · Velvet')
})

it.each(['/missing', '/signin/missing', '/orgs/missing', '/workspace', '/me/worklogs'])('shows a public not-found page at %s without requiring a session', async (path) => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  show(path)

  expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/')
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin')
  expect(screen.queryByRole('button', { name: 'Send sign-in link' })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
})

it.each(['/w/first/missing', '/me/worklog/missing'])('preserves the product shell and not-found experience at %s', async (path) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
    user: { id: 'u1', email: 'person@example.com', github_login: null, name: '', avatar_url: '' },
    memberships: [first], last_workspace: first,
  }) } as Response))
  show(path)

  expect(await screen.findByText('Not Found')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/w/first/settings/profile')
  expect(screen.queryByRole('navigation', { name: 'Public navigation' })).not.toBeInTheDocument()
})

it('redirects a legacy not-invited link to email sign-in without fetching a session', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const router = show('/not-invited')

  expect(await screen.findByRole('button', { name: 'Send sign-in link' })).toBeInTheDocument()
  expect(router.state.location.pathname).toBe('/signin')
  expect(screen.getByLabelText('Email', { exact: true })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /sign in with github/i })).not.toBeInTheDocument()
  expect(fetchMock).not.toHaveBeenCalled()
})
