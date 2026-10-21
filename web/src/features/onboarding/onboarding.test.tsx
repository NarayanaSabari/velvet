import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectAgentCard } from './ConnectAgentCard'
import { Onboarding } from './Onboarding'

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
 *  once it is created. `link()` is what `velvet init` does from a terminal,
 *  adding a key scoped to a project, and `connect()` is that key's first use. */
function fakeServer(start: { memberships?: typeof org[]; projects?: object[] } = {}) {
  let memberships: typeof org[] = start.memberships ?? []
  let projects = start.projects ?? [{ id: 'p1', key: 'priya-site', name: 'Priya site', status: 'active' }]
  let linked = false
  let connected = false
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/v1/me') return response({ user: person, memberships, last_workspace: memberships[0] ?? null })
    if (url === '/api/v1/me/invites') return response({ invites: [] })
    if (url === '/api/v1/me/onboarding') {
      return response({
        state: { has_organisation: memberships.length > 0, has_token: linked, agent_connected: connected },
        suggestion: { name: 'Priya Raman', slug: 'priya-raman', issue_prefix: 'PR' },
        base_url: 'https://velvet.example.com',
      })
    }
    if (url === '/api/v1/me/onboarding/organisation' && method === 'POST') {
      memberships = [org]
      return response(org, 201)
    }
    if (url === '/api/v1/me/tokens') {
      return response({ tokens: linked ? [{
        id: 't1', name: 'velvet CLI on laptop', created_at: '2026-09-25T07:00:00Z',
        last_used_at: connected ? '2026-09-25T07:01:00Z' : null, workspace_slug: 'priya-raman', project_key: 'priya-site',
      }] : [] })
    }
    if (url === '/api/v1/w/priya-raman/projects' && method === 'POST') {
      projects = [{ id: 'p1', key: 'priya-site', name: 'Priya Site', status: 'active' }]
      return response(projects[0], 201)
    }
    if (url === '/api/v1/w/priya-raman/projects') return response({ projects })
    return response({ error: { code: 'not_found', message: `unexpected ${method} ${url}` } }, 404)
  })
  return { fetchMock, link: () => { linked = true }, connect: () => { connected = true } }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('Onboarding', () => {
  it('walks a new person from a default organisation to a linked repository', async () => {
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

    // Step 2: install the CLI and link a repository. No key is ever shown.
    expect(await screen.findByTestId('cli-install')).toHaveTextContent('curl -fsSL https://velvet.example.com/install.sh | VELVET_SERVER=https://velvet.example.com sh')
    expect(screen.getByTestId('cli-init')).toHaveTextContent('velvet init --server https://velvet.example.com')
    expect(screen.getByText('2. Connect agent').closest('li')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByTestId('repo-instructions')).toHaveTextContent('velvet log KEY')
    expect(screen.queryByText(/velvet_[0-9a-f]/)).not.toBeInTheDocument()
    expect(server.fetchMock).not.toHaveBeenCalledWith('/api/v1/me/tokens', expect.objectContaining({ method: 'POST' }))
    expect(screen.getByTestId('agent-connection')).toHaveTextContent('Waiting for velvet init')

    // Arrow keys move between instruction files, as a tab list should.
    screen.getByRole('tab', { name: 'AGENTS.md' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'CLAUDE.md' })).toHaveFocus()

    // velvet init in a terminal makes a scoped key; the page notices it.
    server.link()
    await waitFor(() => expect(screen.getByTestId('agent-connection')).toHaveTextContent('Repository linked.'), { timeout: 5000 })
    expect(within(screen.getByRole('list', { name: 'Linked repositories' })).getByText('priya-site')).toBeInTheDocument()
    server.connect()
    await waitFor(() => expect(screen.getByTestId('agent-connection')).toHaveAttribute('data-connected', 'true'), { timeout: 5000 })
    expect(screen.getByText('Your agent is connected.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to your dashboard' })).toHaveAttribute('href', '/w/priya-raman')
  }, 15000)

  it('asks for a project first when the organisation has none', async () => {
    const server = fakeServer({ projects: [] })
    vi.stubGlobal('fetch', server.fetchMock)
    const user = userEvent.setup()
    show(<Onboarding />)
    await user.click(await screen.findByRole('button', { name: 'Create organisation' }))

    expect(await screen.findByText('Create a project first')).toBeInTheDocument()
    expect(screen.queryByTestId('cli-init')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Project name'), 'Priya Site')
    expect(screen.getByLabelText('Project key')).toHaveValue('priya-site')
    await user.click(screen.getByRole('button', { name: 'Create project' }))
    expect(await screen.findByTestId('cli-init')).toBeInTheDocument()
  })

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

  it('resumes at the connect step for someone who already has an organisation', async () => {
    const server = fakeServer({ memberships: [org] })
    vi.stubGlobal('fetch', server.fetchMock)
    show(<Onboarding />)

    expect(await screen.findByTestId('cli-init')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to your dashboard' })).toHaveAttribute('href', '/w/priya-raman')
    expect(screen.getByText('You can connect more repositories later from Profile, under Agent config.')).toBeInTheDocument()
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
    show(<ConnectAgentCard slug="priya-raman" />)

    const card = await screen.findByTestId('connect-agent-card')
    expect(within(card).getByRole('link', { name: 'Connect an agent' })).toHaveAttribute('href', '/w/priya-raman/settings/profile/agent-config')
    await user.click(within(card).getByRole('button', { name: 'Not now' }))
    expect(screen.queryByTestId('connect-agent-card')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('velvet:agent-card-dismissed')).toBe('1')
  })

  it('stays hidden once an agent has connected', async () => {
    stubState(true)
    const client = show(<ConnectAgentCard slug="priya-raman" />)
    await waitFor(() => expect(client.getQueryData(['onboarding'])).toBeDefined())
    expect(screen.queryByTestId('connect-agent-card')).not.toBeInTheDocument()
  })
})
