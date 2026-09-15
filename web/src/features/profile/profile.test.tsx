import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Profile } from './Profile'

function response(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: async () => body,
  } as Response)
}

const session = {
  user: { id: 'u1', email: 'sabari@example.com', github_id: null, github_login: null, name: 'Sabari', avatar_url: '' },
  last_workspace: null,
  memberships: [],
}

type Token = {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
}

function tokenFetch(initialTokens: Token[]) {
  let tokens = initialTokens.map((token) => ({ ...token }))
  return vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/me') return response(session)
    if (url === '/api/v1/me/tokens' && (!init?.method || init.method === 'GET')) return response({ tokens })
    if (url === '/api/v1/me/tokens' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string }
      const token = {
        id: 'token-2',
        name: body.name,
        created_at: '2026-09-15T10:00:00Z',
        last_used_at: null,
      }
      tokens = [...tokens, token]
      return response({ ...token, token: 'velvet_secret_once' }, 201)
    }
    if (url.startsWith('/api/v1/me/tokens/') && init?.method === 'DELETE') {
      const id = url.split('/').pop()
      tokens = tokens.filter((token) => token.id !== id)
      return response(null, 204)
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
  })
}

function renderProfile() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Profile slug="lab" />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.unstubAllGlobals())

describe('Profile API tokens', () => {
  it('lists token names and relative usage metadata', async () => {
    const createdAt = '2026-09-14T10:00:00Z'
    const lastUsedAt = '2026-09-15T09:00:00Z'
    const fetch = tokenFetch([
      { id: 'token-1', name: 'Build agent', created_at: createdAt, last_used_at: null },
      { id: 'token-2', name: 'Release agent', created_at: createdAt, last_used_at: lastUsedAt },
    ])
    vi.stubGlobal('fetch', fetch)

    renderProfile()

    expect(await screen.findByRole('heading', { name: 'API tokens' })).toBeInTheDocument()
    expect(await screen.findByText('Build agent')).toBeInTheDocument()
    expect(await screen.findByText('Release agent')).toBeInTheDocument()
    expect(screen.getByText(/Never used/)).toBeInTheDocument()
    expect(document.querySelector(`time[dateTime="${createdAt}"]`)).toBeInTheDocument()
    expect(document.querySelector(`time[dateTime="${lastUsedAt}"]`)).toBeInTheDocument()
  })

  it('shows the plaintext token once after creating it', async () => {
    const fetch = tokenFetch([])
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()

    renderProfile()
    const input = await screen.findByLabelText('Token name')
    await user.type(input, 'CLI writer')
    await user.click(screen.getByRole('button', { name: 'Create token' }))

    expect(await screen.findByText('velvet_secret_once')).toBeVisible()
    expect(screen.getByText(/This token will not be shown again/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy API token' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/v1/me/tokens', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'CLI writer' }),
    }))

    await user.click(screen.getByRole('button', { name: 'Dismiss token' }))
    expect(screen.queryByText('velvet_secret_once')).not.toBeInTheDocument()
  })

  it('requires confirmation before revoking a token', async () => {
    const fetch = tokenFetch([{ id: 'token-1', name: 'Old agent', created_at: '2026-09-14T10:00:00Z', last_used_at: '2026-09-15T09:00:00Z' }])
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()

    renderProfile()
    await screen.findByText('Old agent')
    await user.click(screen.getByRole('button', { name: 'Revoke Old agent' }))

    expect(screen.getByText(/Any clients using it will stop working/)).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/me/tokens/token-1', expect.objectContaining({ method: 'DELETE' }))

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Any clients using it will stop working/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Revoke Old agent' }))

    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }))
    await waitFor(() => expect(screen.getByText('No API tokens yet')).toBeInTheDocument())
    expect(fetch).toHaveBeenCalledWith('/api/v1/me/tokens/token-1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('explains the empty state and keeps creation as the action', async () => {
    vi.stubGlobal('fetch', tokenFetch([]))

    renderProfile()

    expect(await screen.findByText('No API tokens yet')).toBeInTheDocument()
    expect(screen.getByText('Let a CLI or coding agent write to your worklog.')).toBeInTheDocument()
    expect(screen.getByLabelText('Token name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create token' })).toBeInTheDocument()
    expect(screen.getByText(/Authorization: Bearer/)).toBeInTheDocument()
  })
})
