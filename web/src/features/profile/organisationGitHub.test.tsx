import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Profile } from './Profile'
import { organisationGitHubQuery, type OrganisationGitHubIdentity } from './organisationGitHub'

const identity: OrganisationGitHubIdentity = {
  workspace_id: 'w1', user_id: 'u1', github_id: 42, github_login: 'work-account',
  linked_at: '2026-10-01T00:00:00Z', source: 'organisation',
}
const session = {
  user: { id: 'u1', email: 'user@example.com', name: 'User', github_id: 1, github_login: 'personal', avatar_url: '' },
  last_workspace: null,
  memberships: ['lab', 'other'].map((slug) => ({
    id: slug, workspace_id: slug === 'lab' ? 'w1' : 'w2', workspace_slug: slug,
    workspace_name: slug === 'lab' ? 'Lab' : 'Other', issue_prefix: 'LAB', role: 'viewer',
  })),
}
function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}
function setup(initial: OrganisationGitHubIdentity | null = identity, options: { loadFails?: boolean; removeFails?: boolean; pauseLoad?: Promise<void>; pauseRemove?: Promise<void> } = {}) {
  let current = initial
  let loadFails = options.loadFails
  let removeFails = options.removeFails
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/me') return response(session)
    if (url === '/api/v1/me/github' && init?.method === 'DELETE') return response(null, 204)
    if (url === '/api/v1/w/other/me/github') return response({ identity: null })
    if (url === '/api/v1/w/lab/me/github') {
      if (init?.method === 'DELETE') {
        await options.pauseRemove
        if (removeFails) return response({ error: { message: 'Removal failed' } }, 500)
        current = { ...identity, github_login: 'personal', source: 'global' }
        return response(null, 204)
      }
      await options.pauseLoad
      if (loadFails) return response({ error: { message: 'Unavailable' } }, 500)
      return response({ identity: current })
    }
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const content = (slug: string) => <QueryClientProvider client={client}><Profile key={slug} slug={slug} page="github" /></QueryClientProvider>
  const view = render(content('lab'))
  return { fetch, client, switchWorkspace: () => view.rerender(content('other')), recover: () => { loadFails = false; removeFails = false } }
}
beforeEach(() => vi.unstubAllGlobals())

describe('Organisation GitHub identity', () => {
  it('shows organisation identity separately from the global account and explains optional access', async () => {
    setup()
    expect(await screen.findByText('Effective account: @work-account')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'GitHub identity for Lab' })).toBeVisible()
    expect(screen.getByText(/Source: organisation link/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Change account' })).toHaveAttribute('href', '/api/v1/w/lab/me/github/link')
    expect(screen.getByRole('heading', { name: 'Global GitHub account' })).toBeVisible()
    expect(screen.getByText('Linked to @personal')).toBeVisible()
    expect(screen.getByText(/GitHub is optional/)).toHaveTextContent('Viewers are read-only')
    expect(screen.getByText(/GitHub is optional/)).toHaveTextContent('even without repository permissions')
    expect(screen.getByText(/Switching Velvet organisations/)).toHaveTextContent('does not require switching GitHub accounts')
  })

  it('treats null as no effective identity and keeps the scoped link available', async () => {
    setup(null)
    expect(await screen.findByText('No effective GitHub identity for this organisation.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Link account' })).toHaveAttribute('href', '/api/v1/w/lab/me/github/link')
    expect(screen.queryByRole('button', { name: 'Remove organisation link' })).not.toBeInTheDocument()
  })

  it('explains an unavailable global fallback without assuming the global account is effective', async () => {
    setup(null)
    expect(await screen.findByText('Your global account is not available as a fallback here. Link a different account to attribute GitHub activity, or keep working without GitHub.')).toBeVisible()
    expect(screen.getByText('Linked to @personal')).toBeVisible()
    expect(screen.queryByText('Effective account: @personal')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Link account' })).toHaveAttribute('href', '/api/v1/w/lab/me/github/link')
    expect(screen.queryByRole('button', { name: 'Remove organisation link' })).not.toBeInTheDocument()
  })

  it('shows fallback source without offering override removal', async () => {
    setup({ ...identity, source: 'global', github_login: 'personal' })
    expect(await screen.findByText(/Source: global account fallback/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Remove organisation link' })).not.toBeInTheDocument()
  })

  it('confirms scoped deletion, focuses cancel, preserves evidence and refreshes fallback', async () => {
    const { fetch } = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Remove organisation link' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(screen.getByText(/Only this organisation override/)).toHaveTextContent('Existing synced evidence remains')
    expect(screen.getByText(/Only this organisation override/)).toHaveTextContent('fallback if available')
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/w/lab/me/github', expect.objectContaining({ method: 'DELETE' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove organisation link' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Remove organisation link' }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove organisation link' }))
    expect(await screen.findByText(/Source: global account fallback/)).toBeVisible()
    expect(fetch).toHaveBeenCalledWith('/api/v1/w/lab/me/github', expect.objectContaining({ method: 'DELETE' }))
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/me/github', expect.objectContaining({ method: 'DELETE' }))
    expect(await screen.findByText('Organisation link removed.')).toBeVisible()
  })

  it('keeps failed removal confirmation available for retry', async () => {
    const view = setup(identity, { removeFails: true })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Remove organisation link' }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove organisation link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Removal failed')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    view.recover()
    await user.click(screen.getByRole('button', { name: 'Confirm remove organisation link' }))
    expect(await screen.findByText(/Source: global account fallback/)).toBeVisible()
  })

  it('announces loading and disables controls while removal is saving', async () => {
    let resolveLoad!: () => void
    let resolveRemove!: () => void
    setup(identity, {
      pauseLoad: new Promise<void>((resolve) => { resolveLoad = resolve }),
      pauseRemove: new Promise<void>((resolve) => { resolveRemove = resolve }),
    })
    const user = userEvent.setup()
    expect(await screen.findByText('Loading organisation GitHub identity…')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Change account' })).not.toBeInTheDocument()
    resolveLoad()
    await user.click(await screen.findByRole('button', { name: 'Remove organisation link' }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove organisation link' }))
    expect(await screen.findByRole('button', { name: 'Removing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    resolveRemove()
    expect(await screen.findByText(/Source: global account fallback/)).toBeVisible()
  })

  it('provides retry for loading errors', async () => {
    const view = setup(identity, { loadFails: true })
    const user = userEvent.setup()
    expect(await screen.findByText('Could not load organisation GitHub identity.')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Change account' })).not.toBeInTheDocument()
    view.recover()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Effective account: @work-account')).toBeVisible()
  })

  it('resets confirmation and uses separate cache entries on workspace switch', async () => {
    const view = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Remove organisation link' }))
    view.switchWorkspace()
    expect(await screen.findByText('No effective GitHub identity for this organisation.')).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Confirm organisation link removal' })).not.toBeInTheDocument()
    expect(view.client.getQueryData(organisationGitHubQuery('lab').queryKey)).toEqual(identity)
    expect(view.client.getQueryData(organisationGitHubQuery('other').queryKey)).toBeNull()
  })

  it('does not move focus into a new workspace when an old removal finishes', async () => {
    let resolveRemove!: () => void
    const view = setup(identity, { pauseRemove: new Promise<void>((resolve) => { resolveRemove = resolve }) })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Remove organisation link' }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove organisation link' }))
    await screen.findByRole('button', { name: 'Removing…' })
    view.switchWorkspace()
    const link = await screen.findByRole('link', { name: 'Link account' })
    const globalTrigger = screen.getByRole('button', { name: 'Unlink GitHub profile' })
    globalTrigger.focus()
    resolveRemove()
    await waitFor(() => expect(view.client.getMutationCache().getAll().some((mutation) => mutation.state.status === 'success')).toBe(true))
    expect(globalTrigger).toHaveFocus()
    expect(link).not.toHaveFocus()
    expect(view.client.getQueryData(organisationGitHubQuery('other').queryKey)).toBeNull()
  })

  it('preserves the global unlink endpoint and invalidates effective identity', async () => {
    const view = setup()
    const user = userEvent.setup()
    await screen.findByText('Effective account: @work-account')
    await user.click(screen.getByRole('button', { name: 'Unlink GitHub profile' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlink GitHub profile' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Unlink GitHub profile' }))
    await user.click(screen.getByRole('button', { name: 'Confirm unlink GitHub profile' }))
    await waitFor(() => expect(view.fetch).toHaveBeenCalledWith('/api/v1/me/github', expect.objectContaining({ method: 'DELETE' })))
    await waitFor(() => expect(view.fetch.mock.calls.filter(([url, init]) => url === '/api/v1/w/lab/me/github' && init?.method === 'GET').length).toBeGreaterThan(1))
  })
})
