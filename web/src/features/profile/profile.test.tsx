import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
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
  memberships: [
    { id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'LAB', role: 'member' },
  ],
}

const setupState = {
  state: { has_organisation: true, has_token: false, agent_connected: false },
  suggestion: { name: 'Sabari', slug: 'sabari', issue_prefix: 'SA' },
  base_url: 'https://velvet.example.com',
}

type Token = {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
}

function tokenFetch(initialTokens: Token[], options: { role?: string; createFails?: boolean } = {}) {
  let tokens = initialTokens.map((token) => ({ ...token }))
  const me = options.role
    ? { ...session, memberships: session.memberships.map((member) => ({ ...member, role: options.role })) }
    : session
  const fetch = vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/me') return response(me)
    if (url === '/api/v1/me/onboarding') return response(setupState)
    if (url === '/api/v1/me/tokens' && (!init?.method || init.method === 'GET')) return response({ tokens })
    if (url === '/api/v1/me/tokens' && init?.method === 'POST') {
      if (options.createFails) return response({ error: { code: 'invalid', message: 'you have reached the 20-token limit' } }, 422)
      const body = JSON.parse(String(init.body)) as { name: string }
      if (tokens.some((token) => token.name === body.name)) {
        return response({ error: { code: 'conflict', message: 'a token with that name already exists' } }, 409)
      }
      const token = {
        id: `token-new-${tokens.length}`,
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
  /** Plays the agent's first call with the newest key. */
  const useNewestToken = () => {
    tokens = tokens.map((token, index) => index === tokens.length - 1 ? { ...token, last_used_at: new Date().toISOString() } : token)
  }
  return Object.assign(fetch, { useNewestToken })
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

    const created = await screen.findByText('Token created')
    expect(within(created.closest('[role="status"]') as HTMLElement).getByText('velvet_secret_once')).toBeVisible()
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
    // With its only key revoked, the agent is no longer reported as connected.
    expect(await screen.findByText('No agent connected yet.')).toBeInTheDocument()
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

describe('Profile agent config', () => {
  it('lets someone who skipped onboarding set up an agent later', async () => {
    const fetch = tokenFetch([])
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()

    renderProfile()

    const section = (await screen.findByRole('heading', { name: 'Agent config' })).closest('section')!
    expect(section).toHaveAttribute('id', 'agent-config')
    expect(await within(section).findByText('No agent connected yet.')).toBeInTheDocument()
    expect(await within(section).findByTestId('agent-mcp-url')).toHaveTextContent('https://velvet.example.com/api/v1/w/lab/mcp')

    await user.click(within(section).getByRole('button', { name: 'Set up an agent' }))

    // A fresh key, shown once, in every agent's setup, with focus on it.
    expect(await within(section).findByTestId('agent-token')).toHaveTextContent('velvet_secret_once')
    expect(within(section).getByRole('heading', { name: 'New key for your agent' })).toHaveFocus()
    expect(within(section).getByTestId('agent-snippet')).toHaveTextContent(
      'claude mcp add --transport http --scope user velvet https://velvet.example.com/api/v1/w/lab/mcp',
    )
    expect(within(section).getByTestId('agent-snippet')).toHaveTextContent('Bearer velvet_secret_once')
    await user.click(within(section).getByRole('tab', { name: 'Cursor' }))
    expect(JSON.parse(within(section).getByTestId('agent-snippet').textContent!)).toEqual({
      mcpServers: { velvet: { url: 'https://velvet.example.com/api/v1/w/lab/mcp', headers: { Authorization: 'Bearer velvet_secret_once' } } },
    })
    expect(fetch).toHaveBeenCalledWith('/api/v1/me/tokens', expect.objectContaining({
      method: 'POST',
      body: expect.stringMatching(/"name":"Coding agent \d{4}-\d{2}-\d{2} \d{2}:\d{2}"/),
    }))
    // The new key is also listed with the person's other API tokens.
    const tokenList = screen.getByRole('heading', { name: 'API tokens' }).closest('section')!
    expect(await within(tokenList).findByText(/^Coding agent \d{4}/)).toBeInTheDocument()

    // The agent's first call with that key flips the status without a reload.
    const connection = within(section).getByTestId('agent-connection')
    expect(connection).toHaveAttribute('data-connected', 'false')
    fetch.useNewestToken()
    await waitFor(() => expect(connection).toHaveAttribute('data-connected', 'true'), { timeout: 5000 })
    expect(within(section).getByText('Your agent is connected.')).toBeInTheDocument()
    expect(within(section).getByTestId('agent-config-status')).toHaveTextContent(/Connected\. Coding agent .* was last used/)

    await user.click(within(section).getByRole('button', { name: 'Done' }))
    expect(within(section).queryByTestId('agent-token')).not.toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Set up another agent' })).toBeInTheDocument()
  }, 10000)

  it('shows an already connected agent and offers another', async () => {
    vi.stubGlobal('fetch', tokenFetch([
      { id: 'token-1', name: 'Laptop agent', created_at: '2026-09-14T10:00:00Z', last_used_at: '2026-09-15T09:00:00Z' },
      { id: 'token-2', name: 'Old agent', created_at: '2026-09-10T10:00:00Z', last_used_at: '2026-09-11T09:00:00Z' },
    ]))

    renderProfile()

    const status = await screen.findByTestId('agent-config-status')
    await waitFor(() => expect(status).toHaveTextContent('Connected. Laptop agent was last used'))
    expect(screen.getByRole('button', { name: 'Set up another agent' })).toBeInTheDocument()
  })

  it('tells a viewer that their agent can only read', async () => {
    vi.stubGlobal('fetch', tokenFetch([], { role: 'viewer' }))

    renderProfile()

    expect(await screen.findByText(/You are a viewer in Lab, so an agent can read its tickets but cannot log work/)).toBeInTheDocument()
  })

  it('numbers a second agent key set up in the same minute', async () => {
    // Pin only the clock, so the existing key's minute matches the new one.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-25T07:30:15Z'))
    try {
      const fetch = tokenFetch([{ id: 'token-1', name: 'Coding agent 2026-09-25 07:30', created_at: '2026-09-25T07:30:00Z', last_used_at: null }])
      vi.stubGlobal('fetch', fetch)
      const user = userEvent.setup()

      renderProfile()
      await user.click(await screen.findByRole('button', { name: 'Set up an agent' }))

      expect(await screen.findByTestId('agent-token')).toHaveTextContent('velvet_secret_once')
      const names = fetch.mock.calls
        .filter(([url, init]) => url === '/api/v1/me/tokens' && (init as RequestInit | undefined)?.method === 'POST')
        .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { name: string }).name)
      expect(names).toEqual(['Coding agent 2026-09-25 07:30', 'Coding agent 2026-09-25 07:30 (2)'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a failed key without leaving the section', async () => {
    vi.stubGlobal('fetch', tokenFetch([], { createFails: true }))
    const user = userEvent.setup()

    renderProfile()
    await user.click(await screen.findByRole('button', { name: 'Set up an agent' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('you have reached the 20-token limit')
    expect(screen.getByRole('button', { name: 'Set up an agent' })).toBeEnabled()
    expect(screen.queryByTestId('agent-token')).not.toBeInTheDocument()
  })
})
