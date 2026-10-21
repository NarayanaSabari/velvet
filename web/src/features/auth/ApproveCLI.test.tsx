import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'

import { ApproveCLI } from './ApproveCLI'

const membership = { id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role: 'member' }
const user = { id: 'u1', email: 'person@example.com', name: '', github_id: null, github_login: null, avatar_url: '' }

function response(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response)
}

beforeEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/cli/approve?code=ABCD-EFGH')
})

it('creates a project inline when the organisation has none, then connects to it', async () => {
  const projects: unknown[] = []
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/v1/me') return response({ user, memberships: [membership] })
    if (url === '/api/v1/cli/sessions/ABCD-EFGH') return response({ id: 's1', user_code: 'ABCD-EFGH', client_name: 'velvet CLI on box', expires_at: '2099-01-01T00:00:00Z' })
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

  await screen.findByText('Connected.')
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/cli/sessions/ABCD-EFGH/approve', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ workspace_slug: 'lab', project_key: 'otter' }),
  }))
})
