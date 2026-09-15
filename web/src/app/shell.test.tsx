import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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

beforeEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
})

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
        memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role: 'admin' }],
      }),
    } as Response))

    renderShell()
    await waitFor(() => expect(screen.getAllByText('Lab').length).toBeGreaterThan(0))
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
        memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role: 'member' }],
      }),
    } as Response))

    renderShell('lab')
    await waitFor(() => expect(screen.getAllByText('Lab').length).toBeGreaterThan(0))
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Open account menu' }))
    expect(screen.getByRole('link', { name: 'New organisation' })).toHaveAttribute('href', '/orgs/new')
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/w/lab/settings/profile')
    expect(screen.getByRole('button', { name: 'Leave organisation' })).toBeInTheDocument()
  })

  it('marks the current desktop navigation item as active', async () => {
    window.history.replaceState({}, '', '/w/lab/sprints')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
        memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role: 'member' }],
      }),
    } as Response))

    renderShell('lab')
    await waitFor(() => expect(screen.getAllByText('Lab').length).toBeGreaterThan(0))

    const navigation = screen.getByRole('navigation', { name: 'Workspace navigation' })
    const sprints = within(navigation).getByRole('link', { name: 'Sprints' })
    expect(sprints).toHaveAttribute('aria-current', 'page')
    expect(sprints).toHaveClass('bg-grey-100', 'border-l-ink')
  })

  it('renders the compact mobile tab bar and reveals More items', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
        memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role: 'admin' }],
      }),
    } as Response))

    renderShell('lab')
    await waitFor(() => expect(screen.getAllByText('Lab').length).toBeGreaterThan(0))

    const mobileNavigation = screen.getByRole('navigation', { name: 'Mobile navigation' })
    expect(within(mobileNavigation).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(within(mobileNavigation).getByRole('link', { name: 'Feed' })).toBeInTheDocument()
    expect(within(mobileNavigation).getByRole('link', { name: 'Sprints' })).toBeInTheDocument()
    expect(within(mobileNavigation).getByRole('link', { name: 'Mentions' })).toBeInTheDocument()

    await userEvent.click(within(mobileNavigation).getByRole('button', { name: 'More' }))
    const moreMenu = document.getElementById('mobile-more-menu')
    expect(moreMenu).not.toBeNull()
    if (!moreMenu) return
    expect(within(moreMenu).getByRole('link', { name: 'Unlinked PRs' })).toBeInTheDocument()
    expect(within(moreMenu).getByRole('link', { name: 'Reports' })).toBeInTheDocument()
    expect(within(moreMenu).getByRole('link', { name: 'Administration' })).toBeInTheDocument()
    expect(within(moreMenu).getByRole('link', { name: 'Profile' })).toBeInTheDocument()
    expect(within(moreMenu).getByRole('link', { name: 'New organisation' })).toBeInTheDocument()
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
        memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role: 'admin' }],
      }),
    } as Response))

    renderShell('missing')
    expect(await screen.findByText('Organisation not found')).toBeInTheDocument()
    expect(screen.queryByText('content')).toBeNull()
  })
})
