import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'

import { ConfirmSignIn } from './ConfirmSignIn'
import { ApproveCLI } from './ApproveCLI'
import { findPageStatus } from '../../test-utils'

const membership = { id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role: 'member' }
const user = { id: 'u1', email: 'person@example.com', name: '', github_id: null, github_login: null, avatar_url: '' }

function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response)
}

beforeEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/cli/approve?code=ABCD-EFGH')
})

const pendingLogin = { id: 's1', user_code: 'ABCD-EFGH', client_name: 'velvet CLI on box', flow: 'login', expires_at: '2099-01-01T00:00:00Z' }

function showCLI() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ApproveCLI /></QueryClientProvider>)
}

it.each(['member', 'viewer', 'none'])('approves login only on explicit consent for %s without project access', async (role) => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: role === 'none' ? [] : [{ ...membership, role }] })
    if (url.endsWith('/approve')) return response(null, 204)
    return response(pendingLogin)
  })
  vi.stubGlobal('fetch', fetchMock)
  showCLI()
  const approve = await screen.findByRole('button', { name: 'Approve login' })
  expect(screen.getByText('List and create organisations and projects.')).toBeInTheDocument()
  expect(screen.getByText('Routine work uses a separate key, limited to the project you choose.')).toBeInTheDocument()
  expect(screen.getByTestId('cli-user-code')).toHaveTextContent('ABCD-EFGH')
  expect(screen.queryByLabelText('Organisation')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Project')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument()
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/projects'))).toBe(false)
  await userEvent.click(approve)
  await screen.findByRole('heading', { level: 1, name: 'Connected' })
  expect(screen.getByText(/Run this in your repository/)).toBeInTheDocument()
  expect(screen.getByTestId('cli-next-command')).toHaveTextContent('velvet init')
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/cli/sessions/ABCD-EFGH/approve', expect.objectContaining({ method: 'POST', body: '{}', credentials: 'same-origin' }))
})

it.each(['admin', 'member', 'viewer', 'none'])('requires explicit account management consent for %s without project selection', async (role) => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: role === 'none' ? [] : [{ ...membership, role }] })
    if (url.endsWith('/approve')) return response(null, 204)
    return response({ ...pendingLogin, flow: 'manage' })
  })
  vi.stubGlobal('fetch', fetchMock)
  showCLI()
  const approve = await screen.findByRole('button', { name: 'Approve account management' })
  expect(screen.getByText('Act across your whole account, not one project.')).toBeInTheDocument()
  expect(screen.getByText('It is a personal credential, limited by your current memberships and roles.')).toBeInTheDocument()
  expect(screen.getByText('It is separate from the setup access velvet login gives.')).toBeInTheDocument()
  expect(screen.queryByLabelText('Organisation')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Project')).not.toBeInTheDocument()
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/projects'))).toBe(false)
  await userEvent.click(approve)
  expect(await screen.findByText(/Account management is connected/)).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/cli/sessions/ABCD-EFGH/approve', expect.objectContaining({ method: 'POST', body: '{}', credentials: 'same-origin' }))
})

it.each(['admin', 'member', 'viewer', 'none'])('requires explicit desktop app consent for %s without project selection', async (role) => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: role === 'none' ? [] : [{ ...membership, role }] })
    if (url.endsWith('/approve')) return response(null, 204)
    return response({ ...pendingLogin, flow: 'desktop', client_name: 'Velvet for macOS' })
  })
  vi.stubGlobal('fetch', fetchMock)
  showCLI()
  const approve = await screen.findByRole('button', { name: 'Approve desktop app' })
  expect(screen.getByRole('heading', { name: 'Connect Velvet for macOS' })).toBeInTheDocument()
  expect(screen.getByText('It covers all your current and future organisations, limited by your current roles.')).toBeInTheDocument()
  expect(screen.getByText(/It is not a repository or setup key/)).toBeInTheDocument()
  expect(screen.queryByLabelText('Organisation')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Project')).not.toBeInTheDocument()
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/projects'))).toBe(false)
  await userEvent.click(approve)
  expect(await screen.findByText(/Go back to Velvet for macOS/)).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/cli/sessions/ABCD-EFGH/approve', expect.objectContaining({ method: 'POST', body: '{}', credentials: 'same-origin' }))
})

it.each(['login', 'desktop'])('refuses %s without issuing an approval', async (flow) => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: [] })
    if (url.endsWith('/deny')) return response(null, 204)
    return response({ ...pendingLogin, flow })
  })
  vi.stubGlobal('fetch', fetchMock)
  showCLI()
  await userEvent.click(await screen.findByRole('button', { name: 'Refuse' }))
  expect(await screen.findByRole('heading', { level: 1, name: 'Request refused' })).toBeInTheDocument()
  expect(await findPageStatus()).toHaveTextContent('was not given a key')
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/approve'))).toBe(false)
})

it('keeps consent visible on approval failure and retries only on click', async () => {
  let attempts = 0
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: [] })
    if (url.endsWith('/approve')) {
      attempts++
      return attempts === 1 ? response({ error: { message: 'Try again later' } }, 503) : response(null, 204)
    }
    return response(pendingLogin)
  })
  vi.stubGlobal('fetch', fetchMock)
  showCLI()
  await userEvent.click(await screen.findByRole('button', { name: 'Approve login' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Try again later')
  expect(attempts).toBe(1)
  await userEvent.click(screen.getByRole('button', { name: 'Approve login' }))
  await screen.findByRole('heading', { level: 1, name: 'Connected' })
  expect(attempts).toBe(2)
})

it.each(['approve', 'deny'])('disables conflicting actions during %s', async (action) => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: [] })
    if (url.endsWith(`/${action}`)) return new Promise<Response>(() => {})
    return response(pendingLogin)
  })
  vi.stubGlobal('fetch', fetchMock)
  showCLI()
  await userEvent.click(await screen.findByRole('button', { name: action === 'approve' ? 'Approve login' : 'Refuse' }))
  expect(screen.getByRole('button', { name: action === 'approve' ? 'Connecting…' : 'Approve login' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Refuse' })).toBeDisabled()
})

it('retries a lookup failure with the same entered code', async () => {
  let attempts = 0
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: [] })
    attempts++
    return attempts === 1 ? response({ error: { message: 'Unavailable' } }, 503) : response(pendingLogin)
  }))
  showCLI()
  expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable')
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(await screen.findByRole('button', { name: 'Approve login' })).toBeEnabled()
  expect(attempts).toBe(2)
})

it('keeps legacy init blocked for a viewer', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => response(url === '/api/v1/me'
    ? { user, memberships: [{ ...membership, role: 'viewer' }] } : { ...pendingLogin, flow: 'init' })))
  showCLI()
  expect(await screen.findByRole('alert')).toHaveTextContent('You are a viewer in every organisation')
  expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
})

it('rejects unknown session modes rather than treating them as legacy init', async () => {
  const fetchMock = vi.fn().mockImplementation((url: string) => response(url === '/api/v1/me'
    ? { user, memberships: [membership] } : { ...pendingLogin, flow: 'unknown' }))
  vi.stubGlobal('fetch', fetchMock)
  showCLI()
  expect(await screen.findByRole('alert')).toHaveTextContent('not supported')
  // The page names the problem as its title and says what to do about it.
  expect(screen.getByRole('heading', { level: 1, name: 'Request not recognised' })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Update the CLI, then run velvet login again')
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/projects'))).toBe(false)
})

it.each([404, 410])('gives expired consent guidance for HTTP %s', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => url === '/api/v1/me'
    ? response({ user, memberships: [] }) : response({ error: { message: 'expired' } }, status)))
  showCLI()
  expect(await screen.findByRole('alert')).toHaveTextContent('That code no longer works')
  expect(screen.getByRole('alert')).toHaveTextContent('Run velvet login again')
  // The field stays, so a new code can be entered straight away.
  expect(screen.getByLabelText('Code shown on your device')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Approve login' })).not.toBeInTheDocument()
})

it('does not approve an expired session returned by lookup', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => response(url === '/api/v1/me'
    ? { user, memberships: [] } : { ...pendingLogin, expires_at: '2020-01-01T00:00:00Z' })))
  showCLI()
  const approve = await screen.findByRole('button', { name: 'Approve login' })
  await waitFor(() => expect(approve).toBeDisabled())
  expect(screen.getByRole('alert')).toHaveTextContent('expired')
})

it('disables approval when an open session expires', async () => {
  const expiresAt = new Date(Date.now() + 500).toISOString()
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => response(url === '/api/v1/me'
    ? { user, memberships: [] } : { ...pendingLogin, expires_at: expiresAt })))
  showCLI()
  const approve = await screen.findByRole('button', { name: 'Approve login' })
  expect(approve).toBeEnabled()
  await waitFor(() => expect(approve).toBeDisabled(), { timeout: 2000 })
  expect(screen.getByRole('alert')).toHaveTextContent('This request expired')
})

it('includes safe consent context in signed-out email requests without approving', async () => {
  const fetchMock = vi.fn().mockImplementation((url: string) => url === '/api/v1/me'
    ? response({ error: { message: 'signed out' } }, 401) : response({}, 202))
  vi.stubGlobal('fetch', fetchMock)
  showCLI()
  await userEvent.type(await screen.findByLabelText('Email'), 'person@example.com')
  // Keep the request pending to avoid jsdom navigation while inspecting the payload.
  fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
  await userEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }))
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/email', expect.objectContaining({ body: JSON.stringify({ email: 'person@example.com', return_to: '/cli/approve?code=ABCD-EFGH' }) }))
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/approve'))).toBe(false)
})

it('uses persisted server return context in a fresh magic-link tab without auto-approval', async () => {
  window.history.replaceState(null, '', '/signin/confirm#token=magic')
  const fetchMock = vi.fn().mockImplementation(() => response({ next: '/cli/approve?code=ABCD-EFGH' }))
  vi.stubGlobal('fetch', fetchMock)
  const navigate = vi.fn()
  render(<QueryClientProvider client={new QueryClient()}><ConfirmSignIn navigate={navigate} /></QueryClientProvider>)
  expect(fetchMock).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/cli/approve?code=ABCD-EFGH'))
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it.each([undefined, 'init'])('creates a legacy project inline then connects for flow=%s', async (flow) => {
  const projects: unknown[] = []
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/v1/me') return response({ user, memberships: [membership] })
    if (url === '/api/v1/cli/sessions/ABCD-EFGH') return response({ id: 's1', user_code: 'ABCD-EFGH', client_name: 'velvet CLI on box', expires_at: '2099-01-01T00:00:00Z', flow })
    if (url === '/api/v1/w/lab/projects' && init?.method === 'POST') {
      const project = { id: 'p1', key: 'otter', name: 'Otter', status: 'active' }
      projects.push(project)
      return response(project, 201)
    }
    if (url === '/api/v1/w/lab/projects') return response({ projects })
    if (url === '/api/v1/cli/sessions/ABCD-EFGH/approve') return Promise.resolve({ ok: true, status: 204, json: async () => ({}) } as Response)
    return response({ error: { code: 'not_found', message: 'nope' } }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ApproveCLI /></QueryClientProvider>)

  await userEvent.type(await screen.findByLabelText('Project name'), 'Otter')
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Create project' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))

  await screen.findByRole('heading', { level: 1, name: 'Connected' })
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/cli/sessions/ABCD-EFGH/approve', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ workspace_slug: 'lab', project_key: 'otter' }),
  }))
})

function showRefinedCLI() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ApproveCLI /></QueryClientProvider>)
}

it.each([
  ['login', 'Approve login', 'you started velvet login on this device', 'Create repository keys where you have write access.'],
  ['manage', 'Approve account management', 'you started velvet admin login on this device', 'Do not share it with repository agents.'],
  ['desktop', 'Approve desktop app', 'you started sign-in in Velvet for macOS on your device', 'You can revoke it under Profile > API tokens.'],
])('lays a %s request out as check the code, then what approving allows', async (flow, action, only, line) => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: [membership] })
    if (url.endsWith('/approve')) return response(null, 204)
    return response({ ...pendingLogin, flow })
  })
  vi.stubGlobal('fetch', fetchMock)
  showRefinedCLI()

  const approve = await screen.findByRole('button', { name: action })
  expect(screen.getByTestId('cli-user-code')).toHaveTextContent('ABCD-EFGH')
  expect(screen.getByText('Requested by velvet CLI on box')).toBeInTheDocument()
  expect(screen.getByText(`Approve only if ${only}.`)).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '2. What approving allows' })).toBeInTheDocument()
  expect(screen.getByText(line)).toBeInTheDocument()
  // Nothing is sent until the person chooses.
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  await userEvent.click(approve)
  // The outcome becomes the page's title, with where to go next under it.
  expect(await screen.findByRole('heading', { level: 1, name: 'Connected' })).toBeInTheDocument()
  expect(screen.getByText(flow === 'desktop' ? 'Go back to Velvet for macOS.' : 'Go back to your terminal.')).toBeInTheDocument()
  if (flow === 'login') expect(screen.getByTestId('cli-next-command')).toHaveTextContent('velvet init')
  expect(screen.getByText(/revoke it under Profile, in API tokens/)).toBeInTheDocument()
})

it('refusing says nothing was given and how to start again', async () => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: [membership] })
    if (url.endsWith('/deny')) return response(null, 204)
    return response(pendingLogin)
  })
  vi.stubGlobal('fetch', fetchMock)
  showRefinedCLI()

  await userEvent.click(await screen.findByRole('button', { name: 'Refuse' }))
  expect(await screen.findByRole('heading', { level: 1, name: 'Request refused' })).toBeInTheDocument()
  expect(screen.getByText(/The CLI was not given a key\./)).toBeInTheDocument()
  expect(screen.getByText('Run the command again in your terminal to get a new code.')).toBeInTheDocument()
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/approve'))).toBe(false)
})

it('a repository request is a choice of organisation and project, said once', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url === '/api/v1/me') return response({ user, memberships: [membership] })
    if (url.includes('/projects')) return response({ projects: [{ id: 'p1', key: 'web', name: 'Web app', status: 'active' }] })
    return response({ ...pendingLogin, flow: 'init' })
  }))
  showRefinedCLI()

  expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '2. Choose what it can reach' })).toBeInTheDocument()
  expect(screen.getByText('Approve only if you started velvet init in this repository.')).toBeInTheDocument()
  expect(screen.getAllByText(/only this project/)).toHaveLength(1)
})
