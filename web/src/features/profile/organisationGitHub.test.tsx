import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Profile } from './Profile'
import { organisationGitHubQuery, type OrganisationGitHubIdentity } from './organisationGitHub'
import { navigateTo } from '../auth/sessionNavigation'

vi.mock('../auth/sessionNavigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../auth/sessionNavigation')>(),
  navigateTo: vi.fn(),
}))

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
  let globalLinked = true
  let loadFails = options.loadFails
  let removeFails = options.removeFails
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/me') return response(globalLinked ? session : { ...session, user: { ...session.user, github_id: null, github_login: null } })
    if (url === '/api/v1/me/github' && init?.method === 'DELETE') { globalLinked = false; return response(null, 204) }
    if (url === '/api/v1/w/other/me/github') return response({ identity: null })
    if (url === '/api/v1/w/lab/me/github') {
      if (init?.method === 'DELETE') {
        await options.pauseRemove
        if (removeFails) return response({ error: { message: 'Removal failed' } }, 500)
        current = globalLinked ? { ...identity, github_login: 'personal', source: 'global' } : null
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
function row(slug = 'lab') {
  return within(screen.getByTestId(`github-account-row-${slug}`))
}
const removeName = 'Remove organisation link for Lab'
const confirmName = 'Confirm remove organisation link for Lab'
const changeName = 'Change GitHub account for Lab'

beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.mocked(navigateTo).mockClear() })

describe('Table-based GitHub account management', () => {
  it('puts scoped and global controls in the table without duplicate account sections', async () => {
    setup()
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByText('@work-account')).toBeVisible()
    expect(row().getByText('Organisation link')).toBeVisible()
    expect(row().getByRole('link', { name: changeName })).toHaveAttribute('href', '/api/v1/w/lab/me/github/link')
    expect(row().getByRole('button', { name: removeName })).toBeVisible()
    expect(row('global').getByText('@personal')).toBeVisible()
    expect(row('global').getByText('Global default')).toBeVisible()
    expect(row('global').getByRole('button', { name: 'Unlink GitHub profile' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'GitHub identity for Lab' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Global GitHub account' })).not.toBeInTheDocument()
    expect(screen.getByText(/GitHub is optional/)).toBeVisible()
  })

  it('keeps a scoped Link action for an unavailable fallback without guessing an effective account', async () => {
    setup(null)
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByText('Not linked')).toBeVisible()
    expect(row().getByText('Global fallback unavailable')).toBeVisible()
    expect(row().queryByText('@personal')).not.toBeInTheDocument()
    expect(row('global').getByText('@personal')).toBeVisible()
    expect(row().getByRole('link', { name: 'Link GitHub account for Lab' })).toHaveAttribute('href', '/api/v1/w/lab/me/github/link')
    expect(row().queryByRole('button', { name: removeName })).not.toBeInTheDocument()
  })

  it('shows fallback source without offering organisation override removal', async () => {
    setup({ ...identity, source: 'global', github_login: 'personal' })
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByText('Global fallback')).toBeVisible()
    expect(row().getByRole('link', { name: changeName })).toBeVisible()
    expect(row().queryByRole('button', { name: removeName })).not.toBeInTheDocument()
  })

  it('confirms scoped deletion, focuses Cancel, preserves evidence and refreshes fallback', async () => {
    const { fetch, client } = setup()
    client.setQueryData(['authors', 'lab'], ['work-account'])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: removeName }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(screen.getByText(/Only this organisation override/)).toHaveTextContent('Existing synced evidence remains')
    expect(screen.getByText(/Only this organisation override/)).toHaveTextContent('fallback if available')
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/w/lab/me/github', expect.objectContaining({ method: 'DELETE' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(row().getByRole('button', { name: removeName })).toHaveFocus())
    await user.click(row().getByRole('button', { name: removeName }))
    await user.click(screen.getByRole('button', { name: confirmName }))
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByText('Global fallback')).toBeVisible()
    expect(fetch).toHaveBeenCalledWith('/api/v1/w/lab/me/github', expect.objectContaining({ method: 'DELETE' }))
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/me/github', expect.objectContaining({ method: 'DELETE' }))
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByText('Organisation link removed.')).toBeVisible()
    await waitFor(() => expect(row().getByRole('link', { name: changeName })).toHaveFocus())
    expect(client.getQueryData(['authors', 'lab'])).toBeUndefined()
  })

  it('keeps failed removal confirmation available for retry', async () => {
    const view = setup(identity, { removeFails: true })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: removeName }))
    await user.click(screen.getByRole('button', { name: confirmName }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Removal failed')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    view.recover()
    await user.click(screen.getByRole('button', { name: confirmName }))
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByText('Global fallback')).toBeVisible()
  })

  it('announces loading and disables confirmation while removal is saving', async () => {
    let resolveLoad!: () => void
    let resolveRemove!: () => void
    setup(identity, {
      pauseLoad: new Promise<void>((resolve) => { resolveLoad = resolve }),
      pauseRemove: new Promise<void>((resolve) => { resolveRemove = resolve }),
    })
    const user = userEvent.setup()
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByRole('status', { name: 'Loading GitHub account for Lab' })).toBeVisible()
    expect(row().queryByRole('link', { name: changeName })).not.toBeInTheDocument()
    resolveLoad()
    await user.click(await screen.findByRole('button', { name: removeName }))
    await user.click(screen.getByRole('button', { name: confirmName }))
    expect(await screen.findByRole('button', { name: 'Removing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('group', { name: 'Confirm organisation link removal for Lab' })).toBeVisible()
    resolveRemove()
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByText('Global fallback')).toBeVisible()
  })

  it('provides row-local retry for loading errors without offering account mutations', async () => {
    const view = setup(identity, { loadFails: true })
    const user = userEvent.setup()
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByText('Could not load account.')).toBeVisible()
    expect(row().queryByRole('link', { name: changeName })).not.toBeInTheDocument()
    expect(row().queryByRole('button', { name: removeName })).not.toBeInTheDocument()
    view.recover()
    await user.click(row().getByRole('button', { name: 'Retry GitHub account for Lab' }))
    await screen.findByTestId('github-account-row-lab')
    expect(await row().findByText('@work-account')).toBeVisible()
  })

  it('resets confirmation and preserves independent identity caches on workspace navigation', async () => {
    const view = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: removeName }))
    view.switchWorkspace()
    expect(await row('other').findByText('Current organisation')).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Confirm organisation link removal for Lab' })).not.toBeInTheDocument()
    expect(view.client.getQueryData(organisationGitHubQuery('lab').queryKey)).toEqual(identity)
    expect(view.client.getQueryData(organisationGitHubQuery('other').queryKey)).toBeNull()
  })

  it('does not steal focus in a new workspace when an old removal finishes', async () => {
    let resolveRemove!: () => void
    const view = setup(identity, { pauseRemove: new Promise<void>((resolve) => { resolveRemove = resolve }) })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: removeName }))
    await user.click(screen.getByRole('button', { name: confirmName }))
    await screen.findByRole('button', { name: 'Removing…' })
    view.switchWorkspace()
    const link = await row('other').findByRole('link', { name: 'Link GitHub account for Other' })
    const globalTrigger = row('global').getByRole('button', { name: 'Unlink GitHub profile' })
    globalTrigger.focus()
    resolveRemove()
    await waitFor(() => expect(view.client.getMutationCache().getAll().some((mutation) => mutation.state.status === 'success')).toBe(true))
    expect(globalTrigger).toHaveFocus()
    expect(link).not.toHaveFocus()
    expect(view.client.getQueryData(organisationGitHubQuery('other').queryKey)).toBeNull()
  })

  it('preserves global unlink confirmation, endpoint and identity invalidation in its table row', async () => {
    const view = setup()
    const user = userEvent.setup()
    await screen.findByTestId('github-account-row-lab')
    await row().findByText('@work-account')
    await user.click(row('global').getByRole('button', { name: 'Unlink GitHub profile' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(row('global').getByRole('button', { name: 'Unlink GitHub profile' })).toHaveFocus())
    await user.click(row('global').getByRole('button', { name: 'Unlink GitHub profile' }))
    await user.click(screen.getByRole('button', { name: 'Confirm unlink GitHub profile' }))
    await waitFor(() => expect(view.fetch).toHaveBeenCalledWith('/api/v1/me/github', expect.objectContaining({ method: 'DELETE' })))
    await waitFor(() => expect(view.fetch.mock.calls.filter(([url, init]) => url === '/api/v1/w/lab/me/github' && init?.method === 'GET').length).toBeGreaterThan(1))
    expect(await row('global').findByRole('link', { name: 'Link GitHub profile' })).toHaveAttribute('href', '/api/v1/auth/github/link')
    expect(row().getByText('@work-account')).toBeVisible()
  })

  it('keeps removal controls disabled until the updated identity has finished refreshing', async () => {
    const options: { pauseLoad?: Promise<void> } = {}
    setup(identity, options)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: removeName }))
    let release!: () => void
    options.pauseLoad = new Promise<void>((resolve) => { release = resolve })
    try {
      await user.click(screen.getByRole('button', { name: confirmName }))
      expect(await screen.findByRole('button', { name: 'Removing…' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
      expect(row().queryByRole('button', { name: removeName })).not.toBeInTheDocument()
      expect(row().queryByRole('link', { name: changeName })).not.toBeInTheDocument()
    } finally { release() }
    expect(await row().findByText('Global fallback')).toBeVisible()
    await waitFor(() => expect(row().getByRole('link', { name: changeName })).toHaveFocus())
  })

  it('does not start OAuth for an obsolete row after workspace navigation during cache clearing', async () => {
    const view = setup()
    const user = userEvent.setup()
    await screen.findByRole('link', { name: changeName })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cleared = vi.spyOn(view.client, 'clear')
    vi.spyOn(view.client, 'cancelQueries').mockImplementationOnce(() => gate)
    await user.click(row().getByRole('link', { name: changeName }))
    view.switchWorkspace()
    await row('other').findByText('Current organisation')
    release()
    await waitFor(() => expect(cleared).toHaveBeenCalledTimes(1))
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('disables an open removal confirmation after an identity refetch fails', async () => {
    const options = { loadFails: false }
    const view = setup(identity, options)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: removeName }))
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/v1/w/lab/me/github' && init?.method === 'GET') return response({ error: { message: 'Unavailable' } }, 503)
      return originalFetch(input, init)
    }))
    await view.client.invalidateQueries({ queryKey: organisationGitHubQuery('lab').queryKey })
    expect(await row().findByRole('alert')).toHaveTextContent('Could not load account.')
    expect(screen.getByRole('button', { name: confirmName })).toBeDisabled()
    expect(screen.getByText('Refresh the account before removing the link.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: confirmName }))
    expect(view.fetch).not.toHaveBeenCalledWith('/api/v1/w/lab/me/github', expect.objectContaining({ method: 'DELETE' }))
    screen.getByRole('button', { name: 'Cancel' }).focus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(row().getByRole('button', { name: 'Retry GitHub account for Lab' })).toHaveFocus())
  })
})
