import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Recap } from './Recap'
import type { WorklogEntry } from '../../lib/types'

function entry(overrides: Partial<WorklogEntry> = {}): WorklogEntry {
  return {
    day: '2026-09-21',
    at: '2026-09-21T10:00:00+00:00',
    workspace_slug: 'lab',
    workspace_name: 'Lab',
    project_key: 'velvet',
    project_name: 'Velvet',
    kind: 'note',
    title: '',
    body: 'I shipped the recap.',
    ...overrides,
  }
}

function renderRecap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Recap />
    </QueryClientProvider>,
  )
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

describe('Recap', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The whole point of the page: one view spanning every organisation.
  it('groups work by day and organisation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          entries: [
            entry({ body: 'I shipped the recap.' }),
            entry({
              workspace_slug: 'client',
              workspace_name: 'Client',
              project_key: 'client-app',
              kind: 'issue',
              issue_key: 'CLI-1',
              title: 'Fix the dropped retry',
              status: 'todo',
              at: '2026-09-21T09:00:00+00:00',
            }),
          ],
        }),
      ),
    )

    renderRecap()

    expect(await screen.findByText('I shipped the recap.')).toBeInTheDocument()
    expect(screen.getByText('Lab')).toBeInTheDocument()
    expect(screen.getByText('Client')).toBeInTheDocument()
    expect(screen.getByText('CLI-1')).toBeInTheDocument()
    expect(screen.getByText('Fix the dropped retry')).toBeInTheDocument()
    // Both organisations sit under the one day heading.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
  })

  it('links evidence to its source and marks agent entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          entries: [
            entry({ source: 'agent', note_kind: 'progress' }),
            entry({
              kind: 'pull_request',
              title: 'Fix the dropped retry',
              url: 'https://github.com/acme/widgets/pull/42',
            }),
          ],
        }),
      ),
    )

    renderRecap()

    const link = await screen.findByRole('link', { name: 'Fix the dropped retry' })
    expect(link).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/42')
    expect(screen.getByText('agent')).toBeInTheDocument()
    expect(screen.getByText('progress')).toBeInTheDocument()
  })

  // An empty period must say so rather than looking broken.
  it('explains an empty period', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ entries: [] })))
    renderRecap()
    expect(await screen.findByText('No recorded work in this period')).toBeInTheDocument()
  })

  it('announces loading and reports a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    renderRecap()

    expect(screen.getByRole('status')).toHaveTextContent('Loading your work log')
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load your work log.'),
    )
  })

  it('requests the selected period and offers the Markdown form', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries: [] }))
    vi.stubGlobal('fetch', fetchMock)
    renderRecap()

    await screen.findByText('No recorded work in this period')
    const [firstCall] = fetchMock.mock.calls
    expect(firstCall).toBeDefined()
    expect(String(firstCall?.[0])).toContain('/api/v1/me/worklog?days=7')
    expect(screen.getByRole('link', { name: 'Copy as Markdown' })).toHaveAttribute(
      'href',
      '/api/v1/me/worklog.md?days=7',
    )
  })
})
