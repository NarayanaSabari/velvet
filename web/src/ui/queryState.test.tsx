import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TeamFeed } from '../features/feed/TeamFeed'
import { Mentions } from '../features/mentions/Mentions'
import { Reports } from '../features/reports/Reports'
import { IssuePage } from '../features/issues/IssuePage'
import { ErrorState, LoadingState } from './QueryState'

beforeEach(() => vi.unstubAllGlobals())

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response
}

function failure(): Response {
  return json({ error: { code: 'internal', message: 'boom' } }, 500)
}

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

/** Routes each request by path so the order the page asks in does not matter. */
function stubApi(handler: (path: string) => Response) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => handler(String(input)))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('QueryState', () => {
  it('announces loading as a status', () => {
    render(<LoadingState label="Loading issues…" />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading issues…')
  })

  it('announces failure as an alert and offers a retry', async () => {
    const onRetry = vi.fn()
    render(<ErrorState message="Could not load sprints." onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load sprints.')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('disables the retry while it is running', () => {
    render(<ErrorState message="Could not load sprints." onRetry={() => {}} retrying />)
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled()
  })
})

describe('TeamFeed states', () => {
  it('reports a failed load instead of claiming the feed is empty', async () => {
    let fail = true
    const fetch = stubApi((path) => {
      if (path.includes('/activity')) {
        return fail
          ? failure()
          : json({ activity: [], next_cursor: null })
      }
      return json(null, 401)
    })
    renderWithClient(<TeamFeed slug="lab" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the team feed.')
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument()

    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument()
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/activity'))).toHaveLength(2)
  })

  it('separates a filtered-out feed from an empty one and clears the filters', async () => {
    stubApi((path) => {
      if (path.includes('/activity')) return json({ activity: [], next_cursor: null })
      return json(null, 401)
    })
    renderWithClient(<TeamFeed slug="lab" />)

    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Verb'), 'commented')

    expect(await screen.findByText('No matching activity')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument()
    expect(screen.getByLabelText('Verb')).toHaveValue('')
  })
})

describe('Reports states', () => {
  it('fails one report on its own and keeps the others', async () => {
    let failStale = true
    stubApi((path) => {
      if (path.includes('/reports/stale')) return failStale ? failure() : json({ issues: [] })
      if (path.includes('/reports/activity')) return json({ people: [] })
      if (path.includes('/reports/milestones')) return json({ sprints: [] })
      if (path.includes('/reports/closed')) return json({ sprints: [] })
      return json(null, 404)
    })
    renderWithClient(<Reports slug="lab" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load stale work.')
    expect(await screen.findByText('No activity in this period.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    failStale = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/nothing has stalled/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('Mentions states', () => {
  it('recovers from a failed load with Try again', async () => {
    let fail = true
    stubApi(() => (fail ? failure() : json({ mentions: [] })))
    renderWithClient(<Mentions slug="lab" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load mentions.')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No mentions')).toBeInTheDocument()
  })
})

describe('Not found', () => {
  it('shows a missing issue as not found with a way back, not a retryable failure', async () => {
    stubApi((path) => {
      if (path.endsWith('/issues/ENG-999')) return json({ error: { code: 'not_found', message: 'issue not found' } }, 404)
      if (path.endsWith('/me')) return json(null, 401)
      return json({})
    })
    renderWithClient(<IssuePage slug="lab" issueKey="ENG-999" />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Issue not found' })).toBeInTheDocument()
    expect(screen.getByText(/ENG-999 does not exist/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to issues' })).toHaveAttribute('href', '/w/lab/issues')
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })
})
