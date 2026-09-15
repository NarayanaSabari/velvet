import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'

import { SignIn } from './SignIn'
import { ConfirmSignIn } from './ConfirmSignIn'
import { Invite } from './Invite'
import { NewOrganisation } from '../orgs/NewOrganisation'
import { Profile } from '../profile/Profile'
import { LeaveOrganisation } from '../orgs/LeaveOrganisation'
import { DangerPanel } from '../admin/DangerPanel'

const membership = { id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', role: 'viewer' }
const identity = { id: 'u1', email: 'person@example.com', name: '', github_id: null, github_login: null, avatar_url: '' }
const invitation = { id: 'i1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', email: 'person@example.com', role: 'member', expires_at: '2026-09-15T00:00:00Z' }
function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response)
}
function show(children: ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
  return client
}
beforeEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

it('requests an email sign-in and navigates to check email', async () => {
  const fetchMock = vi.fn().mockImplementation(() => response({ status: 'sent' }, 202))
  vi.stubGlobal('fetch', fetchMock)
  const navigate = vi.fn()
  show(<SignIn navigate={navigate} />)
  await userEvent.type(screen.getByLabelText('Email'), 'person@example.com')
  await userEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/check-email'))
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/email', expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'person@example.com' }) }))
})

it('does not consume a confirmation token until the explicit Sign in click, then clears private data and fragment', async () => {
  window.history.replaceState(null, '', '/signin/confirm#token=secret')
  const fetchMock = vi.fn().mockImplementation(() => response({ next: '/orgs/new' }))
  vi.stubGlobal('fetch', fetchMock)
  const client = new QueryClient()
  client.setQueryData(['feed', 'old'], ['private'])
  client.setQueryData(['session'], { user: { id: 'old' } })
  const navigate = vi.fn(() => {
    expect(client.getQueryCache().getAll()).toHaveLength(0)
    expect(window.location.hash).toBe('')
  })
  show(<ConfirmSignIn navigate={navigate} />, client)
  expect(fetchMock).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/magic', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'secret' }) }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/orgs/new'))
})

it('routes an expired sign-in link to the expiry page after an explicit click', async () => {
  window.history.replaceState(null, '', '/signin/confirm#token=expired')
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => response({ error: { code: 'expired', message: 'expired' } }, 410)))
  const navigate = vi.fn()
  show(<ConfirmSignIn navigate={navigate} />)
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/expired'))
})

it('previews without accepting and offers sign-out for the wrong email', async () => {
  window.history.replaceState(null, '', '/invite#token=invite-secret')
  const fetchMock = vi.fn().mockImplementation(() => response({ invite: invitation, signed_in: true, email_matches: false }))
  vi.stubGlobal('fetch', fetchMock)
  show(<Invite />)
  expect(await screen.findByText(/This invitation is for person@example.com/)).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/invite/preview', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'invite-secret' }) }))
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument()
})

it.each([true, false])('accepts an invitation only on click for signed_in=%s', async (signedIn) => {
  window.history.replaceState(null, '', '/invite#token=invite-secret')
  const fetchMock = vi.fn().mockImplementation((url: string) => response(url.endsWith('/preview')
    ? { invite: invitation, signed_in: signedIn, email_matches: signedIn }
    : signedIn ? membership : { status: 'sent' }, url.endsWith('/accept') && !signedIn ? 202 : 200))
  vi.stubGlobal('fetch', fetchMock)
  const navigate = vi.fn()
  show(<Invite navigate={navigate} />)
  await userEvent.click(await screen.findByRole('button', { name: signedIn ? 'Accept invitation' : 'Sign in and accept' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(signedIn ? '/w/lab' : '/check-email'))
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/invite/accept', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'invite-secret' }) }))
  expect(window.location.hash).toBe('')
})

it('shows identity and pending invitations with no membership and accepts by id', async () => {
  const fetchMock = vi.fn().mockImplementation((url: string) => response(url === '/api/v1/me'
    ? { user: identity, memberships: [], last_workspace: null }
    : url.endsWith('/accept') ? membership : { invites: [invitation] }))
  vi.stubGlobal('fetch', fetchMock)
  const navigate = vi.fn()
  show(<NewOrganisation navigate={navigate} />)
  expect(await screen.findByText('person@example.com')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  await userEvent.click(await screen.findByRole('button', { name: 'Accept Lab invitation' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/w/lab'))
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/me/invites/i1/accept', expect.objectContaining({ method: 'POST', body: undefined }))
})

it('creates an organisation with an editable suggested slug and issue prefix', async () => {
  const fetchMock = vi.fn().mockImplementation((url: string) => response(url === '/api/v1/me'
    ? { user: identity, memberships: [], last_workspace: null }
    : url === '/api/v1/orgs' ? membership : { invites: [] }))
  vi.stubGlobal('fetch', fetchMock)
  const navigate = vi.fn()
  show(<NewOrganisation navigate={navigate} />)
  await userEvent.type(await screen.findByLabelText('Organisation name'), 'My Lab')
  expect(screen.getByLabelText('Slug')).toHaveValue('my-lab')
  await userEvent.clear(screen.getByLabelText('Slug'))
  await userEvent.type(screen.getByLabelText('Slug'), 'lab')
  await userEvent.type(screen.getByLabelText('Issue prefix'), 'LAB')
  await userEvent.click(screen.getByRole('button', { name: 'Create organisation' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/w/lab'))
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/orgs', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'My Lab', slug: 'lab', issue_prefix: 'LAB' }) }))
})

it('lets a viewer leave and clears organisation data before navigation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => response(null, 204)))
  const client = new QueryClient()
  client.setQueryData(['memberships', 'lab'], ['private'])
  const navigate = vi.fn(() => expect(client.getQueryData(['memberships', 'lab'])).toBeUndefined())
  show(<LeaveOrganisation slug="lab" navigate={navigate} />, client)
  await userEvent.click(screen.getByRole('button', { name: 'Leave organisation' }))
  await userEvent.click(screen.getByRole('button', { name: 'Confirm leave' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
})

it('requires the exact slug to delete an organisation', async () => {
  const fetchMock = vi.fn().mockImplementation(() => response(null, 204))
  vi.stubGlobal('fetch', fetchMock)
  const navigate = vi.fn()
  show(<DangerPanel slug="lab" navigate={navigate} />)
  expect(screen.getByRole('button', { name: 'Delete organisation' })).toBeDisabled()
  await userEvent.type(screen.getByLabelText('Type lab to confirm deletion'), 'lab')
  await userEvent.click(screen.getByRole('button', { name: 'Delete organisation' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/w/lab', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ confirm: 'lab' }) }))
})

it('links a profile through the distinct authorization endpoint and clears identity projections on unlink', async () => {
  let linked = true
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/v1/me/github' && init?.method === 'DELETE') { linked = false; return response(null, 204) }
    if (url === '/api/v1/me/tokens') return response({ tokens: [] })
    return response({ user: { ...identity, github_login: linked ? 'octocat' : null }, memberships: [membership], last_workspace: membership })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['authors', 'lab'], ['octocat'])
  client.setQueryData(['reports', 'lab'], ['octocat'])
  show(<Profile slug="lab" />, client)
  await userEvent.click(await screen.findByRole('button', { name: 'Unlink GitHub profile' }))
  expect(await screen.findByRole('link', { name: 'Link GitHub profile' })).toHaveAttribute('href', '/api/v1/auth/github/link')
  expect(client.getQueryData(['authors', 'lab'])).toBeUndefined()
  expect(client.getQueryData(['reports', 'lab'])).toBeUndefined()
})
