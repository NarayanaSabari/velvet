import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
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
  user: { id: 'u1', email: 'sabari@example.com', github_id: 1, github_login: 'sabari', name: 'Sabari', avatar_url: '' },
  last_workspace: null,
  memberships: [
    {
      id: 'm1',
      workspace_id: 'w1',
      workspace_slug: 'lab',
      workspace_name: 'Lab',
      issue_prefix: 'ENG',
      role: 'admin',
    },
  ],
}

const workspaceMembers = {
  memberships: [
    {
      id: 'm1',
      workspace_id: 'w1',
      role: 'admin',
      user: adminSession.user,
    },
    {
      id: 'm2',
      workspace_id: 'w1',
      role: 'member',
      user: { id: 'u2', email: 'octocat@example.com', name: '', github_login: null, avatar_url: '' },
    },
  ],
}

function adminFetch() {
  let members = workspaceMembers.memberships.map((member) => ({ ...member }))
  let invites = [{ id: 'i1', workspace_id: 'w1', workspace_name: 'Lab', workspace_slug: 'lab', email: 'pending@example.com', role: 'viewer', expires_at: '2026-09-15T00:00:00Z' }]
  let organisationName = 'Lab'
  return vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/me') return response({
      ...adminSession,
      memberships: adminSession.memberships.map((membership) => ({ ...membership, workspace_name: organisationName })),
    })
    if (url === '/api/v1/w/lab' && init?.method === 'PATCH') {
      organisationName = JSON.parse(String(init.body)).name
      return response({ id: 'w1', name: organisationName, slug: 'lab', issue_prefix: 'ENG' })
    }
    if (url === '/api/v1/w/lab/invites' && init?.method === 'GET') return response({ invites })
    if (url === '/api/v1/w/lab/invites' && init?.method === 'POST') {
      const invite = { ...invites[0], ...JSON.parse(String(init.body)), id: 'i2' }
      invites = [...invites, invite]
      return response(invite, 201)
    }
    if (url === '/api/v1/w/lab/invites/i1/resend' && init?.method === 'POST') return response(invites[0])
    if (url === '/api/v1/w/lab/invites/i1' && init?.method === 'DELETE') { invites = []; return response(null, 204) }
    if (url === '/api/v1/w/lab/memberships/m2' && init?.method === 'DELETE') { members = members.filter((member) => member.id !== 'm2'); return response(null, 204) }
    if (url === '/api/v1/w/lab/github') return response({ installation: { id: 99, account_login: 'acme' }, status: 'error', error: 'verification_required' })
    if (url === '/api/v1/w/lab/memberships' && (!init?.method || init.method === 'GET')) {
      return response({ memberships: members })
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
    if (url === '/api/v1/w/lab/memberships/m2' && init?.method === 'PATCH') {
      members = members.map((member) => member.id === 'm2' ? { ...member, role: 'viewer' } : member)
      return response(members[1])
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
  })
}

beforeEach(() => vi.unstubAllGlobals())

describe('Admin', () => {
  it('renders the current organisation name and saves a changed name', async () => {
    const fetch = adminFetch()
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    renderAdmin()

    const name = await screen.findByLabelText('Organisation name')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(name).toHaveValue('Lab')
    expect(save).toBeDisabled()

    await user.clear(name)
    await user.type(name, 'Velvet Otter')
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/v1/w/lab',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Velvet Otter' }) }),
    ))
    await waitFor(() => expect(name).toHaveValue('Velvet Otter'))
  })

  it('shows the API validation error when the organisation name cannot be saved', async () => {
    const fallback = adminFetch()
    const fetch = vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/v1/w/lab' && init?.method === 'PATCH') {
        return response({ error: { code: 'invalid_request', message: 'organisation name must be between 1 and 80 characters' } }, 400)
      }
      return fallback(input, init)
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    renderAdmin()

    const name = await screen.findByLabelText('Organisation name')
    await user.clear(name)
    await user.type(name, 'Invalid request')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('organisation name must be between 1 and 80 characters')
  })

  it('explains how to disconnect in GitHub without locally removing the installation', async () => {
    const fetch = adminFetch()
    vi.stubGlobal('fetch', fetch)
    renderAdmin()
    await userEvent.click(await screen.findByText('Disconnect GitHub'))
    expect(screen.getByText(/To disconnect, uninstall the App in the GitHub account/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open GitHub App settings' })).toHaveAttribute('href', 'https://github.com/settings/installations')
    expect(screen.getByRole('link', { name: 'Organisation uninstall instructions' })).toHaveAttribute('href', 'https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps')
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('labels retained disconnected repositories instead of claiming they are synced', async () => {
    const fallback = adminFetch()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/v1/w/lab/repos') return response({ repos: [{
        id: 'r1', workspace_id: 'w1', installation_id: 99, github_id: 555,
        owner: 'acme', name: 'widgets', default_branch: 'main',
        synced_at: '2026-09-07T10:00:00Z', disconnected_at: '2026-09-08T10:00:00Z',
      }] })
      return fallback(input, init)
    }))
    renderAdmin()
    expect(await screen.findByText('Disconnected')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'acme/widgets' })).toBeInTheDocument()
    expect(screen.queryByText('Synced')).not.toBeInTheDocument()
  })

  it('lists memberships and connected repositories', async () => {
    vi.stubGlobal('fetch', adminFetch())
    renderAdmin()

    expect(await screen.findByRole('heading', { name: 'Administration' })).toBeInTheDocument()
    expect(await screen.findByText('octocat@example.com')).toBeInTheDocument()
    expect(await screen.findByText('pending@example.com')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'acme/widgets' })).toHaveAttribute(
      'href',
      'https://github.com/acme/widgets',
    )
  })

  it('invites by email and changes a member role', async () => {
    const fetch = adminFetch()
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    renderAdmin()

    await user.type(await screen.findByLabelText('Invite email'), 'new-user@example.com')
    await user.selectOptions(screen.getByLabelText('Invite role'), 'viewer')
    await user.click(screen.getByRole('button', { name: 'Send invite' }))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/w/lab/invites',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'new-user@example.com', role: 'viewer' }),
        }),
      ),
    )

    await user.selectOptions(screen.getByLabelText('Role for octocat@example.com'), 'viewer')
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/w/lab/memberships/m2',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ role: 'viewer' }) }),
      ),
    )
    await waitFor(() => expect(screen.getByLabelText('Role for octocat@example.com')).toHaveValue('viewer'))
    expect(await screen.findByText('new-user@example.com')).toBeInTheDocument()
  })

  it('resends and revokes pending invitations through their dedicated endpoints', async () => {
    const fetchMock = adminFetch()
    vi.stubGlobal('fetch', fetchMock)
    renderAdmin()
    await userEvent.click(await screen.findByRole('button', { name: 'Resend invitation to pending@example.com' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/invites/i1/resend', expect.objectContaining({ method: 'POST' })))
    await userEvent.click(screen.getByRole('button', { name: 'Revoke invitation to pending@example.com' }))
    expect(screen.getByText(/will no longer be able to join/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/v1/w/lab/invites/i1', expect.objectContaining({ method: 'DELETE' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke invitation' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/invites/i1', expect.objectContaining({ method: 'DELETE' })))
    await waitFor(() => expect(screen.queryByText('pending@example.com')).not.toBeInTheDocument())
  })

  it('announces invitation loading and names a pending resend', async () => {
    const fallback = adminFetch()
    let resolveInvitations!: (value: Response) => void
    const invitations = new Promise<Response>((resolve) => { resolveInvitations = resolve })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/w/lab/invites' && !init?.method) {
        return invitations
      }
      if (url === '/api/v1/w/lab/invites/i1/resend' && init?.method === 'POST') {
        return new Promise<Response>(() => {})
      }
      return fallback(input, init)
    }))
    renderAdmin()
    expect(await screen.findByText('Loading invitations…')).toHaveAttribute('role', 'status')

    await act(async () => {
      resolveInvitations(await response({ invites: [{ id: 'i1', workspace_id: 'w1', workspace_name: 'Lab', workspace_slug: 'lab', email: 'pending@example.com', role: 'viewer', expires_at: '2026-09-15T00:00:00Z' }] }))
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Resend invitation to pending@example.com' }))
    expect(await screen.findByRole('button', { name: 'Resending invitation to pending@example.com…' })).toBeDisabled()
  })

  it.each(['Resend', 'Revoke'])('clears a failed invite error when starting a successful %s', async (action) => {
    const fallback = adminFetch()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/v1/w/lab/invites' && init?.method === 'POST') {
        return response({ error: { code: 'internal', message: 'Could not send invitation' } }, 500)
      }
      return fallback(input, init)
    }))
    renderAdmin()
    await userEvent.type(await screen.findByLabelText('Invite email'), 'new-user@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send invitation')

    await userEvent.click(screen.getByRole('button', { name: `${action} invitation to pending@example.com` }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    if (action === 'Revoke') {
      await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke invitation' }))
      expect(await screen.findByText('No pending invitations.')).toBeInTheDocument()
    } else {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Resend invitation to pending@example.com' })).toBeEnabled())
    }
  })

  it.each(['Resend', 'Revoke'])('clears a failed %s error when sending a new invitation', async (action) => {
    const fallback = adminFetch()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === `/api/v1/w/lab/invites/i1${action === 'Resend' ? '/resend' : ''}` && init?.method === (action === 'Resend' ? 'POST' : 'DELETE')) {
        return response({ error: { code: 'internal', message: 'Could not update invitation' } }, 500)
      }
      return fallback(input, init)
    }))
    renderAdmin()
    await userEvent.click(await screen.findByRole('button', { name: `${action} invitation to pending@example.com` }))
    if (action === 'Revoke') {
      await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke invitation' }))
    }
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update invitation')

    await userEvent.type(screen.getByLabelText('Invite email'), 'new-user@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    expect(await screen.findByText('new-user@example.com')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('removes a member after confirmation', async () => {
    const fetchMock = adminFetch()
    vi.stubGlobal('fetch', fetchMock)
    renderAdmin()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove octocat@example.com' }))
    expect(screen.getByText(/will lose access to this organisation/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm removal' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab/memberships/m2', expect.objectContaining({ method: 'DELETE' })))
    await waitFor(() => expect(screen.queryByLabelText('Role for octocat@example.com')).not.toBeInTheDocument())
  })

  it('preserves the role and displays the server last-admin refusal', async () => {
    const fallback = adminFetch()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input.endsWith('/memberships/m1') && init?.method === 'PATCH') return response({ error: { code: 'last_admin', message: 'the organisation must retain at least one admin' } }, 409)
      return fallback(input, init)
    }))
    renderAdmin()
    await userEvent.selectOptions(await screen.findByLabelText('Role for Sabari'), 'viewer')
    expect(await screen.findByRole('alert')).toHaveTextContent('must retain at least one admin')
    expect(screen.getByLabelText('Role for Sabari')).toHaveValue('admin')
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

  it.each(['member', 'viewer'])('does not load admin resources for a %s', async (role) => {
    const fetch = vi.fn().mockImplementation(() =>
      response({
        ...adminSession,
        memberships: [{ ...adminSession.memberships[0], role }],
      }),
    )
    vi.stubGlobal('fetch', fetch)
    renderAdmin()

    expect(await screen.findByText('Admin access required')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
