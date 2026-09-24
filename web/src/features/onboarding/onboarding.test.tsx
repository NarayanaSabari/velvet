import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { agentSnippets, mcpUrl } from './agentSnippets'
import { ConnectAgentCard } from './ConnectAgentCard'
import { Onboarding } from './Onboarding'

const TOKEN = 'velvet_0123456789abcdef'
const person = { id: 'u1', email: 'priya@example.com', name: 'Priya Raman', github_id: null, github_login: null, avatar_url: '' }
const org = { id: 'm1', workspace_id: 'w1', workspace_slug: 'priya-raman', workspace_name: 'Priya Raman', issue_prefix: 'PR', role: 'admin' }

function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response)
}

function show(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
  return client
}

/** A small fake server: the session starts empty and gains an organisation
 *  once it is created, and the token becomes used once `connect()` is called. */
function fakeServer() {
  let memberships: typeof org[] = []
  let connected = false
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/v1/me') return response({ user: person, memberships, last_workspace: null })
    if (url === '/api/v1/me/invites') return response({ invites: [] })
    if (url === '/api/v1/me/onboarding') {
      return response({
        state: { has_organisation: memberships.length > 0, has_token: false, agent_connected: connected },
        suggestion: { name: 'Priya Raman', slug: 'priya-raman', issue_prefix: 'PR' },
        base_url: 'https://velvet.example.com',
      })
    }
    if (url === '/api/v1/me/onboarding/organisation' && method === 'POST') {
      memberships = [org]
      return response(org, 201)
    }
    if (url === '/api/v1/me/tokens' && method === 'POST') return response({ id: 't1', name: 'Coding agent', token: TOKEN }, 201)
    return response({ error: { code: 'not_found', message: `unexpected ${method} ${url}` } }, 404)
  })
  return { fetchMock, connect: () => { connected = true } }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('agent snippets', () => {
  it('points every agent at the organisation MCP URL with the token', () => {
    const snippets = agentSnippets('https://velvet.example.com/', 'priya-raman', TOKEN)
    expect(mcpUrl('https://velvet.example.com/', 'priya-raman')).toBe('https://velvet.example.com/api/v1/w/priya-raman/mcp')
    expect(snippets.map((s) => s.id)).toEqual(['claude', 'codex', 'cursor', 'vscode', 'other'])
    for (const snippet of snippets) {
      expect(snippet.code).toContain('https://velvet.example.com/api/v1/w/priya-raman/mcp')
      expect(snippet.code).toContain(TOKEN)
    }
  })

  it('produces commands and JSON the tools accept', () => {
    const byId = Object.fromEntries(agentSnippets('https://v.example', 'lab', TOKEN).map((s) => [s.id, s]))
    expect(byId.claude!.code).toBe(
      `claude mcp add --transport http --scope user velvet https://v.example/api/v1/w/lab/mcp \\\n  --header "Authorization: Bearer ${TOKEN}"`,
    )
    expect(byId.codex!.code).toContain('codex mcp add velvet --url https://v.example/api/v1/w/lab/mcp --bearer-token-env-var VELVET_TOKEN')
    expect(JSON.parse(byId.cursor!.code)).toEqual({
      mcpServers: { velvet: { url: 'https://v.example/api/v1/w/lab/mcp', headers: { Authorization: `Bearer ${TOKEN}` } } },
    })
    expect(JSON.parse(byId.vscode!.code).servers.velvet.type).toBe('http')
    expect(JSON.parse(byId.other!.code).mcpServers.velvet.args).toEqual([
      '-y', 'mcp-remote', 'https://v.example/api/v1/w/lab/mcp', '--header', `Authorization: Bearer ${TOKEN}`,
    ])
    expect(byId.other!.after).not.toContain(TOKEN)
  })
})

describe('Onboarding', () => {
  it('walks a new person from a default organisation to a connected agent', async () => {
    const server = fakeServer()
    vi.stubGlobal('fetch', server.fetchMock)
    const user = userEvent.setup()
    show(<Onboarding />)

    // Step 1: the organisation is prefilled from the person's name.
    const preview = await screen.findByTestId('onboarding-org-preview')
    expect(within(preview).getByText('Priya Raman')).toBeInTheDocument()
    expect(within(preview).getByText('/w/priya-raman')).toBeInTheDocument()
    expect(screen.getByText('1. Organisation').closest('li')).toHaveAttribute('aria-current', 'step')
    await user.click(screen.getByRole('button', { name: 'Create organisation' }))
    expect(server.fetchMock).toHaveBeenCalledWith('/api/v1/me/onboarding/organisation',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }))

    // Step 2: one key for the agent.
    await user.click(await screen.findByRole('button', { name: 'Create API key' }))

    // Step 3: the key and config are shown, and the screen waits for the agent.
    expect(await screen.findByTestId('onboarding-token')).toHaveTextContent(TOKEN)
    expect(screen.getByTestId('onboarding-mcp-url')).toHaveTextContent('https://velvet.example.com/api/v1/w/priya-raman/mcp')
    expect(screen.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('onboarding-snippet')).toHaveTextContent('claude mcp add --transport http')
    expect(screen.getByTestId('onboarding-connection')).toHaveAttribute('data-connected', 'false')

    // Arrow keys move between agents, as a tab list should.
    screen.getByRole('tab', { name: 'Claude Code' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Codex' })).toHaveFocus()
    expect(screen.getByTestId('onboarding-snippet')).toHaveTextContent('codex mcp add velvet')

    server.connect()
    await waitFor(() => expect(screen.getByTestId('onboarding-connection')).toHaveAttribute('data-connected', 'true'), { timeout: 5000 })
    expect(screen.getByText('Your agent is connected.')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Go to your dashboard' })[0]).toHaveAttribute('href', '/w/priya-raman')
  }, 10000)

  it('lets the person change the defaults before creating', async () => {
    const server = fakeServer()
    vi.stubGlobal('fetch', server.fetchMock)
    const user = userEvent.setup()
    show(<Onboarding />)

    await user.click(await screen.findByRole('button', { name: 'Change these' }))
    const name = screen.getByLabelText('Organisation name')
    expect(name).toHaveValue('Priya Raman')
    await user.clear(name)
    await user.type(name, 'Acme')
    await user.clear(screen.getByLabelText('Address'))
    await user.type(screen.getByLabelText('Address'), 'acme')
    await user.clear(screen.getByLabelText('Ticket prefix'))
    await user.type(screen.getByLabelText('Ticket prefix'), 'acm')
    await user.click(screen.getByRole('button', { name: 'Create organisation' }))

    expect(server.fetchMock).toHaveBeenCalledWith('/api/v1/me/onboarding/organisation',
      expect.objectContaining({ body: JSON.stringify({ name: 'Acme', slug: 'acme', issue_prefix: 'ACM' }) }))
  })

  it('offers pending invitations before creating a new organisation', async () => {
    const invitation = { id: 'i1', workspace_id: 'w2', workspace_slug: 'team', workspace_name: 'Team', email: 'priya@example.com', role: 'member', expires_at: '2026-10-01T00:00:00Z' }
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/me') return response({ user: person, memberships: [], last_workspace: null })
      if (url === '/api/v1/me/invites') return response({ invites: [invitation] })
      if (url === '/api/v1/me/invites/i1/accept') return response({ ...org, workspace_slug: 'team', workspace_name: 'Team' })
      return response({ state: { has_organisation: false, has_token: false, agent_connected: false }, suggestion: { name: 'Priya Raman', slug: 'priya-raman', issue_prefix: 'PR' }, base_url: 'https://v.example' })
    }))
    const navigate = vi.fn()
    const user = userEvent.setup()
    show(<Onboarding navigate={navigate} />)

    await user.click(await screen.findByRole('button', { name: 'Accept Team invitation' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/w/team'))
  })

  it('reports a failed organisation create without losing the step', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/v1/me') return response({ user: person, memberships: [], last_workspace: null })
      if (url === '/api/v1/me/invites') return response({ invites: [] })
      if (init?.method === 'POST') return response({ error: { code: 'internal', message: 'could not create the organisation' } }, 500)
      return response({ state: { has_organisation: false, has_token: false, agent_connected: false }, suggestion: { name: 'Priya Raman', slug: 'priya-raman', issue_prefix: 'PR' }, base_url: 'https://v.example' })
    }))
    const user = userEvent.setup()
    show(<Onboarding />)

    await user.click(await screen.findByRole('button', { name: 'Create organisation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not create the organisation')
    expect(screen.getByRole('button', { name: 'Create organisation' })).toBeEnabled()
  })

  it('resumes at the key step for someone who already has an organisation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/me') return response({ user: person, memberships: [org], last_workspace: org })
      return response({ state: { has_organisation: true, has_token: true, agent_connected: false }, suggestion: { name: 'Priya Raman', slug: 'priya-raman-2', issue_prefix: 'PR' }, base_url: 'https://v.example' })
    }))
    show(<Onboarding />)

    expect(await screen.findByRole('button', { name: 'Create API key' })).toBeInTheDocument()
    expect(screen.getByText(/only shown when it is created/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Skip for now and go to your dashboard' })).toHaveAttribute('href', '/w/priya-raman')
  })
})

describe('ConnectAgentCard', () => {
  function stubState(connected: boolean) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => response({
      state: { has_organisation: true, has_token: connected, agent_connected: connected },
      suggestion: { name: 'x', slug: 'xyz', issue_prefix: 'XY' },
      base_url: 'https://v.example',
    })))
  }

  it('invites a person without a connected agent to set one up, and can be dismissed', async () => {
    stubState(false)
    const user = userEvent.setup()
    show(<ConnectAgentCard />)

    const card = await screen.findByTestId('connect-agent-card')
    expect(within(card).getByRole('link', { name: 'Connect an agent' })).toHaveAttribute('href', '/onboarding')
    await user.click(within(card).getByRole('button', { name: 'Not now' }))
    expect(screen.queryByTestId('connect-agent-card')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('velvet:agent-card-dismissed')).toBe('1')
  })

  it('stays hidden once an agent has connected', async () => {
    stubState(true)
    const client = show(<ConnectAgentCard />)
    await waitFor(() => expect(client.getQueryData(['onboarding'])).toBeDefined())
    expect(screen.queryByTestId('connect-agent-card')).not.toBeInTheDocument()
  })
})
