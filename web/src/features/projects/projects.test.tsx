import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectsPage } from './ProjectsPage'

function response(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: async () => body,
  } as Response)
}

const membership = {
  id: 'membership-1',
  workspace_id: 'workspace-1',
  workspace_slug: 'lab',
  workspace_name: 'Lab',
  issue_prefix: 'ENG',
  role: 'admin' as const,
}

const project = {
  id: 'project-1',
  workspace_id: 'workspace-1',
  key: 'velvet',
  name: 'Velvet worklog',
  description: '',
  status: 'active' as const,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  archived_at: null,
  issue_counts: { todo: 1 },
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ProjectsPage slug="lab" />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.unstubAllGlobals())

describe('ProjectsPage', () => {
  it('keeps archive confirmation open and reports a failed mutation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/me') {
        return response({
          user: { id: 'user-1', email: 'sabari@example.test', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
          memberships: [membership],
          last_workspace: membership,
        })
      }
      if (url === '/api/v1/w/lab/projects' && (!init?.method || init.method === 'GET')) {
        return response({ projects: [project] })
      }
      if (url === '/api/v1/w/lab/projects/velvet' && init?.method === 'PATCH') {
        return response({ error: { code: 'internal', message: 'Could not archive project' } }, 500)
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    }))
    const user = userEvent.setup()

    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Archive' }))
    await user.click(screen.getByRole('button', { name: 'Confirm archive Velvet worklog' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not archive project')
    expect(screen.getByText('Archive Velvet worklog?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm archive Velvet worklog' })).toBeEnabled()
  })
})
