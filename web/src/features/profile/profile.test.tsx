import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Profile } from './Profile'
import type { ApiToken as Token } from './apiTokens'
import type { ProfilePageId } from './profilePages'

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

type FakeProject = { id: string; key: string; name: string; status: 'active' }

function tokenFetch(initialTokens: Token[], options: { role?: string; createFails?: boolean; projects?: FakeProject[] } = {}) {
  let tokens = initialTokens.map((token) => ({ ...token }))
  let projects = [...(options.projects ?? [])]
  const me = options.role
    ? { ...session, memberships: session.memberships.map((member) => ({ ...member, role: options.role })) }
    : session
  const fetch = vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/me') return response(me)
    if (url === '/api/v1/me/onboarding') return response(setupState)
    if (url === '/api/v1/w/lab/projects' && (!init?.method || init.method === 'GET')) return response({ projects })
    if (url === '/api/v1/w/lab/projects' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { key: string; name: string }
      const project = { id: `p-${body.key}`, key: body.key, name: body.name, status: 'active' as const }
      projects = [...projects, project]
      return response(project, 201)
    }
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
      tokens = tokens.filter((token) => token.id !== id && token.parent_id !== id)
      return response(null, 204)
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
  })
  /** Plays the agent's first call with the newest key. */
  const useNewestToken = () => {
    tokens = tokens.map((token, index) => index === tokens.length - 1 ? { ...token, last_used_at: new Date().toISOString() } : token)
  }
  /** Plays `velvet init` approved for a project in this organisation. */
  const linkRepository = (project: string) => {
    tokens = [...tokens, { id: `cli-${project}`, name: 'velvet CLI on laptop', created_at: new Date().toISOString(), last_used_at: null, workspace_slug: 'lab', project_key: project }]
  }
  return Object.assign(fetch, { useNewestToken, linkRepository })
}

function renderProfile(page: ProfilePageId = 'agent-config') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const content = (current: ProfilePageId) => <QueryClientProvider client={client}>
    <Profile slug="lab" page={current} />
  </QueryClientProvider>
  const view = render(content(page))
  return { ...view, openPage: (current: ProfilePageId) => view.rerender(content(current)) }
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

    renderProfile('tokens')

    expect(await screen.findByRole('heading', { name: 'API tokens', level: 1 })).toBeInTheDocument()
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

    renderProfile('tokens')
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

    const view = renderProfile('tokens')
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
    // With its only key revoked, the agent page uses the invalidated cache.
    view.openPage('agent-config')
    expect(await screen.findByText('Waiting for velvet init…')).toBeInTheDocument()
  })

  it('identifies setup and derived keys and warns before revoking the whole machine', async () => {
    const created_at = '2026-09-14T10:00:00Z'
    const fetch = tokenFetch([
      { id: 'setup-1', name: 'Laptop setup', kind: 'setup', created_at, last_used_at: null },
      { id: 'project-1', name: 'Billing repository', kind: 'project', parent_id: 'setup-1', workspace_slug: 'lab', project_key: 'billing', created_at, last_used_at: null },
    ])
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    renderProfile('tokens')

    expect(await screen.findByText('Machine setup key')).toBeInTheDocument()
    expect(screen.getByText('Derived project key · lab / billing')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Revoke Laptop setup' }))
    const warning = screen.getByRole('group', { name: 'Confirm revocation of Laptop setup' })
    expect(warning).toHaveTextContent('all project keys derived from it')
    expect(warning).toHaveTextContent('Every repository using those keys will stop working')
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/me/tokens/setup-1', expect.objectContaining({ method: 'DELETE' }))
    await user.click(within(warning).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Confirm revocation of Laptop setup' })).not.toBeInTheDocument()
    expect(screen.getByText('Billing repository')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Revoke Laptop setup' }))
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }))
    await screen.findByText('No API tokens yet')
    expect(fetch).toHaveBeenCalledWith('/api/v1/me/tokens/setup-1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('explains the empty state and keeps creation as the action', async () => {
    vi.stubGlobal('fetch', tokenFetch([]))

    renderProfile('tokens')

    expect(await screen.findByText('No API tokens yet')).toBeInTheDocument()
    expect(screen.getByText('Let a CLI or coding agent write to your worklog.')).toBeInTheDocument()
    expect(screen.getByLabelText('Token name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create token' })).toBeInTheDocument()
    expect(screen.getByText(/Authorization: Bearer/)).toBeInTheDocument()
  })
})

describe('Profile agent config', () => {
  const projects: FakeProject[] = [
    { id: 'p1', key: 'velvet', name: 'Velvet app', status: 'active' },
    { id: 'p2', key: 'billing', name: 'Billing', status: 'active' },
  ]

  it('shows how to install the CLI and link a repository, without ever showing a key', async () => {
    const fetch = tokenFetch([], { projects })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()

    renderProfile()

    const section = (await screen.findByRole('heading', { name: 'Agent config', level: 2 })).closest('section')!
    expect(section).toHaveAttribute('id', 'agent-config')
    expect(await within(section).findByTestId('cli-install')).toHaveTextContent('https://velvet.example.com/install.sh')
    expect(within(section).getByTestId('cli-init')).toHaveTextContent('velvet init --server https://velvet.example.com')
    expect(within(section).getByText(/To disconnect one repository, revoke its project key/)).toHaveTextContent('Running velvet logout signs out this whole machine and revokes all project keys derived from its setup key')
    expect(within(section).getByText(/Projects: velvet, billing\./)).toBeInTheDocument()
    expect(within(section).getByTestId('agent-connection')).toHaveTextContent('Waiting for velvet init…')

    const block = within(section).getByTestId('repo-instructions')
    expect(block).toHaveTextContent('## Velvet work log')
    expect(block).toHaveTextContent('velvet log KEY')
    expect(block.textContent).not.toMatch(/velvet_[0-9a-f]{6,}|Bearer|mcp/i)
    await user.click(within(section).getByRole('tab', { name: 'Cursor rule' }))
    expect(within(section).getByTestId('repo-instructions').textContent).toMatch(/^---\ndescription: Log work to Velvet\nalwaysApply: true\n---/)
    expect(within(section).getByText(/\.cursor\/rules\/velvet\.mdc/)).toBeInTheDocument()

    // Nothing on this page creates a key: velvet init does, on the machine.
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/me/tokens', expect.objectContaining({ method: 'POST' }))
  })

  it('lists the repositories linked to this organisation, live', async () => {
    const fetch = tokenFetch([
      { id: 'personal', name: 'Old personal key', created_at: '2026-09-10T10:00:00Z', last_used_at: '2026-09-11T09:00:00Z' },
      { id: 'other-org', name: 'velvet CLI on desk', created_at: '2026-09-12T10:00:00Z', last_used_at: '2026-09-12T11:00:00Z', workspace_slug: 'elsewhere', project_key: 'x' },
    ], { projects })
    vi.stubGlobal('fetch', fetch)

    renderProfile()

    // Personal keys and keys for other organisations do not count.
    const connection = await screen.findByTestId('agent-connection')
    await waitFor(() => expect(connection).toHaveTextContent('Waiting for velvet init…'))
    fetch.linkRepository('billing')
    await waitFor(() => expect(connection).toHaveTextContent('Repository linked.'), { timeout: 5000 })
    expect(within(connection).getByText('billing')).toBeInTheDocument()
    expect(connection).toHaveAttribute('data-connected', 'false')
    fetch.useNewestToken()
    await waitFor(() => expect(connection).toHaveAttribute('data-connected', 'true'), { timeout: 5000 })
    expect(connection).toHaveTextContent('Your agent is connected.')
  }, 15000)

  it('creates the first project in place, then shows the link command', async () => {
    const fetch = tokenFetch([])
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()

    renderProfile()

    const section = await screen.findByTestId('repo-setup')
    expect(await within(section).findByText('Create a project first')).toBeInTheDocument()
    expect(within(section).queryByTestId('cli-init')).not.toBeInTheDocument()
    await user.type(within(section).getByLabelText('Project name'), 'Mobile App')
    expect(within(section).getByLabelText('Project key')).toHaveValue('mobile-app')
    await user.click(within(section).getByRole('button', { name: 'Create project' }))

    expect(fetch).toHaveBeenCalledWith('/api/v1/w/lab/projects', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'Mobile App', key: 'mobile-app' }),
    }))
    expect(await within(section).findByTestId('cli-init')).toBeInTheDocument()
    expect(within(section).getByText(/Projects: mobile-app\./)).toBeInTheDocument()
  })

  it('tells a viewer they cannot link a repository that writes', async () => {
    vi.stubGlobal('fetch', tokenFetch([], { role: 'viewer', projects }))

    renderProfile()

    const section = await screen.findByTestId('repo-setup')
    expect(await within(section).findByText(/You are a viewer in Lab, so you cannot connect a repository that writes/)).toBeInTheDocument()
    expect(within(section).queryByTestId('cli-init')).not.toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument()
  })
})
