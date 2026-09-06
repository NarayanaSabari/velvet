import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Mentions } from './Mentions'

beforeEach(() => vi.unstubAllGlobals())

describe('Mentions', () => {
  it('shows mentions and marks the inbox read', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200, json: async () => ({ mentions: [{
          comment: {
            id: 'c1', workspace_id: 'w1', target_type: 'issue', target_id: 'i1', parent_id: null,
            author: { id: 'u2', github_login: 'teammate', name: 'Teammate', avatar_url: '' },
            body: '@sabari please review', created_at: '2026-01-01T00:00:00Z', edited_at: null, deleted_at: null,
          },
          read_at: null,
        }] }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
    vi.stubGlobal('fetch', fetch)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><Mentions slug="lab" /></QueryClientProvider>)

    expect(await screen.findByText('@sabari please review')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    expect(fetch).toHaveBeenCalledWith('/api/v1/w/lab/mentions/read', expect.objectContaining({ method: 'POST' }))
  })
})
