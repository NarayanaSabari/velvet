import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { createAppRouter } from '../routes/router'

it('probe', async () => {
  const admin = { id: 'm1', workspace_id: 'w1', workspace_slug: 'first', workspace_name: 'First', issue_prefix: 'ONE', role: 'admin' }
  vi.stubGlobal('scrollTo', vi.fn())
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, status: 200, json: async () =>
    url === '/api/v1/me' ? { user: { id: 'u1', email: 'p@e.com', github_login: null, name: 'Ada', avatar_url: '' }, memberships: [admin], last_workspace: admin }
    : url.endsWith('/memberships') ? { memberships: [] } : url.endsWith('/invites') ? { invites: [] } : url.endsWith('/repos') ? { repos: [] } : {} } as Response)))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/w/first/admin/members'] }), client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  const nav = await screen.findByRole('navigation', { name: 'Workspace navigation' })
  await screen.findByRole('heading', { level: 1, name: 'Members' })
  const link = within(nav).getByRole('link', { name: 'Administration' })
  console.log('OUTER', link.outerHTML.slice(0, 300), 'LOCATION', window.location.pathname)
  expect(true).toBe(true)
})
