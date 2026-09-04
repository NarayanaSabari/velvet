import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { Shell } from './Shell'

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Shell>
        <div>content</div>
      </Shell>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.unstubAllGlobals())

describe('Shell', () => {
  it('shows the sign-in prompt when unauthenticated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'unauthenticated', message: 'sign-in required' } }),
    } as Response))

    renderShell()
    expect(await screen.findByRole('link', { name: /sign in with github/i })).toBeInTheDocument()
  })

  it('renders the workspace and content once signed in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
        memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', role: 'admin' }],
      }),
    } as Response))

    renderShell()
    await waitFor(() => expect(screen.getByText('Lab')).toBeInTheDocument())
    expect(screen.getByText('content')).toBeInTheDocument()
  })

  it('does not flash the sign-in prompt while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderShell()
    expect(screen.queryByRole('link', { name: /sign in with github/i })).toBeNull()
  })
})
