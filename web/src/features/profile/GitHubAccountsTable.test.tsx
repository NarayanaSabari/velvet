import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Membership, SessionPayload } from '../../lib/types'
import { GitHubAccountsTable } from './GitHubAccountsTable'
import { Profile } from './Profile'
import { organisationGitHubQuery, type OrganisationGitHubIdentity } from './organisationGitHub'

const memberships: Membership[] = ['client-a', 'client-b', 'client-c'].map((slug, index) => ({
  id: `m${index}`, workspace_id: `w${index}`, workspace_slug: slug,
  workspace_name: `Client ${String.fromCharCode(65 + index)}`, issue_prefix: 'CL', role: 'viewer',
}))
const scoped: OrganisationGitHubIdentity = {
  workspace_id: 'w0', user_id: 'u1', github_id: 42, github_login: 'work-account',
  linked_at: '2026-10-01T00:00:00Z', source: 'organisation',
}
const global: OrganisationGitHubIdentity = { ...scoped, workspace_id: 'w1', github_id: 1, github_login: 'personal', source: 'global' }
const session: SessionPayload = {
  user: { id: 'u1', email: 'user@example.test', name: 'User', github_id: 1, github_login: 'personal', avatar_url: '' },
  memberships, last_workspace: memberships[0] ?? null,
}
function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}
function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
}
function renderTable(queryClient: QueryClient, members = memberships, hasGlobalAccount = true) {
  const content = (current: Membership[]) => <QueryClientProvider client={queryClient}>
    <GitHubAccountsTable memberships={current} currentSlug="client-a" hasGlobalAccount={hasGlobalAccount} />
  </QueryClientProvider>
  const view = render(content(members))
  return { ...view, updateMemberships: (current: Membership[]) => view.rerender(content(current)) }
}
function row(slug: string) {
  return within(screen.getByTestId(`github-account-row-${slug}`))
}

beforeEach(() => vi.unstubAllGlobals())

describe('GitHub accounts by organisation', () => {
  it('shows scoped accounts, global fallbacks, numeric IDs and unavailable fallbacks without guessing', async () => {
    const queryClient = client()
    const identities = [scoped, global, null]
    const fetch = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      expect(options?.method).toBe('GET')
      const index = memberships.findIndex((member) => String(input) === `/api/v1/w/${member.workspace_slug}/me/github`)
      if (index < 0) throw new Error('Unexpected request')
      return response({ identity: identities[index] })
    })
    vi.stubGlobal('fetch', fetch)
    renderTable(queryClient)

    expect(await row('client-a').findByText('@work-account')).toBeVisible()
    expect(row('client-a').getByText('ID 42')).toBeVisible()
    expect(row('client-a').getByText('Organisation link')).toBeVisible()
    expect(row('client-a').getByText('Current organisation')).toBeVisible()
    expect(row('client-a').getByRole('link', { name: 'Client A' })).toHaveAttribute('href', '/w/client-a/settings/profile/github')
    expect(await row('client-b').findByText('@personal')).toBeVisible()
    expect(row('client-b').getByText('ID 1')).toBeVisible()
    expect(row('client-b').getByText('Global fallback')).toBeVisible()
    expect(await row('client-c').findByText('Not linked')).toBeVisible()
    expect(row('client-c').getByText('Global fallback unavailable')).toBeVisible()
    expect(row('client-c').queryByText('@personal')).not.toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'GitHub accounts by organisation' })).toBeVisible()
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Organisation', 'GitHub account', 'Link type'])
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true)
  })

  it('does not mark a pending row as unlinked or delay already loaded rows', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/client-b/')) await gate
      return response({ identity: String(input).includes('/client-a/') ? scoped : global })
    }))
    renderTable(client(), memberships.slice(0, 2))
    try {
      expect(await row('client-a').findByText('@work-account')).toBeVisible()
      expect(row('client-b').getByRole('status', { name: 'Loading GitHub account for Client B' })).toBeVisible()
      expect(row('client-b').queryByText('Not linked')).not.toBeInTheDocument()
    } finally { release() }
    expect(await row('client-b').findByText('@personal')).toBeVisible()
  })

  it('retries a failed row without hiding other accounts or treating the failure as no link', async () => {
    let fails = true
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/client-b/')) {
        if (fails) return response({ error: { code: 'unavailable', message: 'Unavailable' } }, 503)
        return response({ identity: global })
      }
      return response({ identity: scoped })
    })
    vi.stubGlobal('fetch', fetch)
    renderTable(client(), memberships.slice(0, 2))
    expect(await row('client-b').findByRole('alert')).toHaveTextContent('Could not load account.')
    expect(row('client-b').getByText('Unavailable')).toBeVisible()
    expect(row('client-b').queryByText('Not linked')).not.toBeInTheDocument()
    expect(row('client-a').getByText('@work-account')).toBeVisible()
    fails = false
    await userEvent.setup().click(row('client-b').getByRole('button', { name: 'Retry GitHub account for Client B' }))
    expect(await row('client-b').findByText('@personal')).toBeVisible()
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/client-a/'))).toHaveLength(1)
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/client-b/'))).toHaveLength(2)
  })

  it('shares the current identity request and refreshes its row after confirmed scoped removal', async () => {
    let removed = false
    const fetch = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/me') return response(session)
      if (url === '/api/v1/w/client-a/me/github') {
        if (options?.method === 'DELETE') { removed = true; return response(null, 204) }
        return response({ identity: removed ? { ...global, workspace_id: 'w0' } : scoped })
      }
      if (url === '/api/v1/w/client-b/me/github') return response({ identity: global })
      if (url === '/api/v1/w/client-c/me/github') return response({ identity: null })
      throw new Error('Unexpected request')
    })
    vi.stubGlobal('fetch', fetch)
    render(<QueryClientProvider client={client()}><Profile slug="client-a" page="github" /></QueryClientProvider>)
    await screen.findByText('Effective account: @work-account')
    expect(row('client-a').getByText('@work-account')).toBeVisible()
    expect(fetch.mock.calls.filter(([input, options]) => String(input) === '/api/v1/w/client-a/me/github' && options?.method !== 'DELETE')).toHaveLength(1)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Remove organisation link' }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove organisation link' }))
    expect(await row('client-a').findByText('@personal')).toBeVisible()
    expect(row('client-a').getByText('Global fallback')).toBeVisible()
    expect(row('client-b').getByText('@personal')).toBeVisible()
  })

  it('refreshes global fallback rows after unlink while preserving organisation overrides', async () => {
    let unlinked = false
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/me') return response(unlinked ? { ...session, user: { ...session.user, github_id: null, github_login: null } } : session)
      if (url === '/api/v1/me/github' && options?.method === 'DELETE') { unlinked = true; return response(null, 204) }
      if (url === '/api/v1/w/client-a/me/github') return response({ identity: scoped })
      if (url === '/api/v1/w/client-b/me/github') return response({ identity: unlinked ? null : global })
      if (url === '/api/v1/w/client-c/me/github') return response({ identity: null })
      throw new Error('Unexpected request')
    }))
    render(<QueryClientProvider client={client()}><Profile slug="client-a" page="github" /></QueryClientProvider>)
    await screen.findByText('Effective account: @work-account')
    expect(await row('client-b').findByText('@personal')).toBeVisible()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Unlink GitHub profile' }))
    await user.click(screen.getByRole('button', { name: 'Confirm unlink GitHub profile' }))
    expect(await row('client-b').findByText('Not linked')).toBeVisible()
    await waitFor(() => expect(row('client-b').getByText('None')).toBeVisible())
    expect(row('client-a').getByText('@work-account')).toBeVisible()
    expect(row('client-a').getByText('Organisation link')).toBeVisible()
  })

  it('removes revoked memberships even when their identity response arrives later', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/client-b/')) await gate
      return response({ identity: scoped })
    }))
    const view = renderTable(client(), memberships.slice(0, 2))
    await row('client-a').findByText('@work-account')
    view.updateMemberships(memberships.slice(0, 1))
    release()
    await waitFor(() => expect(screen.queryByTestId('github-account-row-client-b')).not.toBeInTheDocument())
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })

  it('shows an ordinary unlinked account without a global fallback and makes no requests for no memberships', async () => {
    const queryClient = client()
    queryClient.setQueryData(organisationGitHubQuery('client-a').queryKey, null)
    const fetch = vi.fn(async () => response({ identity: null }))
    vi.stubGlobal('fetch', fetch)
    const view = renderTable(queryClient, memberships.slice(0, 1), false)
    expect(await row('client-a').findByText('Not linked')).toBeVisible()
    expect(row('client-a').getByText('None')).toBeVisible()
    view.unmount()
    fetch.mockClear()
    renderTable(client(), [], false)
    expect(screen.getByText('No organisations to show.')).toBeVisible()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })
})
