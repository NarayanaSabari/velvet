import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Admin } from './Admin'

function response(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: async () => body,
  } as Response)
}

function renderAdmin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Admin slug="lab" />
    </QueryClientProvider>,
  )
}

const adminSession = {
  user: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
  memberships: [
    {
      id: 'm1',
      workspace_id: 'w1',
      workspace_slug: 'lab',
      workspace_name: 'Lab',
      role: 'admin',
    },
  ],
}

const workspaceMembers = {
  memberships: [
    {
      id: 'm1',
      workspace_id: 'w1',
      invited_login: 'sabari',
      role: 'admin',
      user: adminSession.user,
    },
    {
      id: 'm2',
      workspace_id: 'w1',
      invited_login: 'octocat',
      role: 'member',
      user: null,
    },
  ],
}

function adminFetch() {
  return vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/me') return response(adminSession)
    if (url === '/api/v1/w/lab/github') return response({ installation: { id: 99, account_login: 'acme' }, status: 'error', error: 'verification_required' })
    if (url === '/api/v1/w/lab/memberships' && (!init?.method || init.method === 'GET')) {
      return response(workspaceMembers)
    }
    if (url === '/api/v1/w/lab/repos' && (!init?.method || init.method === 'GET')) {
      return response({
        repos: [
          {
            id: 'r1',
            workspace_id: 'w1',
            installation_id: 99,
            github_id: 555,
            owner: 'acme',
            name: 'widgets',
            default_branch: 'main',
            synced_at: null,
          },
        ],
      })
    }
    if (url === '/api/v1/w/lab/memberships' && init?.method === 'POST') {
      return response(workspaceMembers.memberships[1], 201)
    }
    if (url === '/api/v1/w/lab/memberships/m2' && init?.method === 'PATCH') {
      return response({ ...workspaceMembers.memberships[1], role: 'viewer' })
    }
    if (url === '/api/v1/w/lab/repos' && init?.method === 'POST') {
      return response({}, 201)
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
  })
}

beforeEach(() => vi.unstubAllGlobals())

describe('Admin', () => {
  it('lists memberships and connected repositories', async () => {
    vi.stubGlobal('fetch', adminFetch())
    renderAdmin()

    expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument()
    expect(await screen.findByText('@octocat')).toBeInTheDocument()
    expect(screen.getByText('Invite pending')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'acme/widgets' })).toHaveAttribute(
      'href',
      'https://github.com/acme/widgets',
    )
  })

  it('invites a GitHub login and changes a role', async () => {
    const fetch = adminFetch()
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    renderAdmin()

    await user.type(await screen.findByLabelText('GitHub login'), 'new-user')
    await user.selectOptions(screen.getByLabelText('Invite role'), 'viewer')
    await user.click(screen.getByRole('button', { name: 'Send invite' }))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/w/lab/memberships',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ github_login: 'new-user', role: 'viewer' }),
        }),
      ),
    )

    await user.selectOptions(screen.getByLabelText('Role for octocat'), 'viewer')
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/w/lab/memberships/m2',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ role: 'viewer' }) }),
      ),
    )
  })

  it('offers ownership verification without manual repository identifiers', async () => {
    const fetch = adminFetch()
    vi.stubGlobal('fetch', fetch)
    renderAdmin()
    expect(await screen.findByRole('link', { name: 'Verify GitHub ownership' })).toHaveAttribute('href', '/api/v1/w/lab/github/connect')
    expect(screen.queryByLabelText('GitHub repository ID')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry sync' })).not.toBeInTheDocument()
  })

  it('retries verified synchronization and refreshes status', async () => {
    const fallback = adminFetch()
    let requested = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/v1/w/lab/github/sync' && init?.method === 'POST') {
        requested = true
        return response({ status: 'syncing' }, 202)
      }
      if (input === '/api/v1/w/lab/github') return response({ installation: { id: 99, account_login: 'acme' }, status: requested ? 'syncing' : 'error', error: requested ? null : 'sync_failed' })
      return fallback(input, init)
    }))
    renderAdmin()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry sync' }))
    expect(await screen.findByText('Syncing repositories…')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Verify GitHub ownership' })).not.toBeInTheDocument()
  })

  it('labels email-only members without a GitHub prefix', async () => {
    const fallback = adminFetch()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/v1/w/lab/memberships') return response({ memberships: [{ id: 'm3', role: 'member', user: { email: 'email@example.com', name: '', github_login: null } }] })
      return fallback(input, init)
    }))
    renderAdmin()
    expect(await screen.findByLabelText('Role for email@example.com')).toBeInTheDocument()
    expect(screen.getByText('email@example.com')).toBeInTheDocument()
    expect(screen.queryByText('@email@example.com')).not.toBeInTheDocument()
  })

  it('retries a failed suspension check and observes the restored connection', async () => {
    const fallback = adminFetch()
    let requested = false
    let checks = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/v1/w/lab/github/sync' && init?.method === 'POST') {
        requested = true
        return response({ status: 'syncing' }, 202)
      }
      if (input === '/api/v1/w/lab/github') return response({
        installation: { id: 99, account_login: 'acme' },
        status: requested && ++checks > 1 ? 'connected' : 'suspended',
        error: requested ? null : 'sync_failed',
      })
      return fallback(input, init)
    }))
    renderAdmin()
    expect(await screen.findByText('GitHub access is paused until its installation state can be verified.')).toBeInTheDocument()
    expect(screen.queryByText('GitHub has suspended this installation. Restore it in GitHub to resume synchronization.')).not.toBeInTheDocument()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry sync' }))
    expect(await screen.findByText('Connected to acme.', {}, { timeout: 4000 })).toBeInTheDocument()
  })

  it('loads repositories again when installation sync finishes', async () => {
    let complete = false
    let repoReads = 0
    const fallback = adminFetch()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/v1/w/lab/github') {
        const status = complete ? 'connected' : 'syncing'
        complete = true
        return response({ installation: { id: 99, account_login: 'acme' }, status, error: null })
      }
      if (input === '/api/v1/w/lab/repos') return response({ repos: ++repoReads > 1 ? [{ id: 'r2', owner: 'acme', name: 'newly-synced', default_branch: 'main' }] : [] })
      return fallback(input, init)
    }))
    renderAdmin()
    expect(await screen.findByRole('link', { name: 'acme/newly-synced' }, { timeout: 4000 })).toBeInTheDocument()
  })

  it('does not load admin resources for a non-admin', async () => {
    const fetch = vi.fn().mockImplementation(() =>
      response({
        ...adminSession,
        memberships: [{ ...adminSession.memberships[0], role: 'member' }],
      }),
    )
    vi.stubGlobal('fetch', fetch)
    renderAdmin()

    expect(await screen.findByText('Admin access required')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
