import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { SignOutButton } from '../features/auth/SignOutButton'
import { Shell } from './Shell'

function renderShell(slug?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Shell slug={slug}>
        <div>content</div>
      </Shell>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.unstubAllGlobals())

describe('Shell', () => {
  it('shows the sign-in prompt when unauthenticated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'unauthenticated', message: 'sign-in required' } }),
    } as Response))

    renderShell()
    expect(await screen.findByRole('button', { name: 'Send sign-in link' })).toBeInTheDocument()
  })

  it('renders the workspace and content once signed in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
        memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', role: 'admin' }],
      }),
    } as Response))

    renderShell()
    await waitFor(() => expect(screen.getByText('Lab')).toBeInTheDocument())
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Administration' })).toHaveAttribute(
      'href',
      '/w/lab/admin',
    )
  })

  it('does not flash the sign-in prompt while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderShell()
    expect(screen.queryByRole('link', { name: /sign in with github/i })).toBeNull()
  })

  it('shows administration navigation only to admins', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
        memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', role: 'member' }],
      }),
    } as Response))

    renderShell('lab')
    await screen.findByText('Lab')
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull()
    expect(screen.getByRole('link', { name: 'New organisation' })).toHaveAttribute('href', '/orgs/new')
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/w/lab/settings/profile')
    expect(screen.getByRole('button', { name: 'Leave organisation' })).toBeInTheDocument()
  })

  it('signs out with POST, clears the cached session, and navigates to sign-in', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'signed_out' }),
    } as Response)
    vi.stubGlobal('fetch', fetch)
    const navigate = vi.fn()
    const client = new QueryClient()
    client.setQueryData(['session'], { user: { id: 'u1' } })
    client.setQueryData(['feed', 'lab'], ['private'])

    render(
      <QueryClientProvider client={client}>
        <SignOutButton navigate={navigate} />
      </QueryClientProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/signin'))
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(client.getQueryData(['session'])).toBeUndefined()
    expect(client.getQueryData(['feed', 'lab'])).toBeUndefined()
  })

  it('reports a failed sign-out without discarding the cached session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const navigate = vi.fn()
    const client = new QueryClient()
    client.setQueryData(['session'], { user: { id: 'u1' } })

    render(
      <QueryClientProvider client={client}>
        <SignOutButton navigate={navigate} />
      </QueryClientProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out')
    expect(client.getQueryData(['session'])).toBeDefined()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not silently substitute another workspace for an unknown slug', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
        memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', role: 'admin' }],
      }),
    } as Response))

    renderShell('missing')
    expect(await screen.findByText('Organisation not found')).toBeInTheDocument()
    expect(screen.queryByText('content')).toBeNull()
  })
})
