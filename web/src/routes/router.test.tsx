import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAppRouter } from './router'

describe('public auth routes', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('shows the not-invited explanation without requiring a session', async () => {
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'unauthenticated', message: 'sign-in required' } }),
    } as Response))
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/not-invited'] }))

    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'Not invited' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /sign in with github/i })).toBeNull()
  })
})
