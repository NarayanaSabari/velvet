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

  it('connects a repository with the existing repo API', async () => {
    const fetch = adminFetch()
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    renderAdmin()

    await user.type(await screen.findByLabelText('Repository owner'), 'openai')
    await user.type(screen.getByLabelText('Repository name'), 'codex')
    await user.type(screen.getByLabelText('GitHub repository ID'), '1234')
    await user.type(screen.getByLabelText('GitHub App installation ID'), '5678')
    await user.clear(screen.getByLabelText('Default branch'))
    await user.type(screen.getByLabelText('Default branch'), 'trunk')
    await user.click(screen.getByRole('button', { name: 'Connect repository' }))

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/w/lab/repos',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            github_id: 1234,
            owner: 'openai',
            name: 'codex',
            installation_id: 5678,
            default_branch: 'trunk',
          }),
        }),
      ),
    )
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
