import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { UnlinkedPRs } from './UnlinkedPRs'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <UnlinkedPRs slug="lab" />
    </QueryClientProvider>,
  )
}

const stray = {
  id: 'pr1',
  number: 46,
  title: 'Unrelated dependency bump',
  state: 'open',
  draft: false,
  author_login: 'arun',
  additions: 12,
  deletions: 4,
  html_url: 'https://github.com/acme/widgets/pull/46',
  merged_at: null,
  head_ref: 'chore/bump-deps',
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('UnlinkedPRs', () => {
  it('lists a pull request that matched no issue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ pull_requests: [stray] }),
      } as Response),
    )

    renderPage()
    // Unmatched work has to stay visible; dropping it silently is how people
    // stop trusting the record.
    expect(await screen.findByText('Unrelated dependency bump')).toBeInTheDocument()
    expect(screen.getByText('#46')).toBeInTheDocument()
    expect(screen.getByText('chore/bump-deps')).toBeInTheDocument()
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.queryByText('open', { exact: true })).toBeNull()
  })

  it('says so plainly when nothing is unlinked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ pull_requests: [] }),
      } as Response),
    )

    renderPage()
    expect(await screen.findByText(/nothing unlinked/i)).toBeInTheDocument()
  })

  it('attaches a PR to an issue key in one step', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url.includes('/pull-requests/unlinked')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ pull_requests: [stray] }),
          } as Response)
        }
        if (url.includes('/issues/ENG-42/prs')) {
          return Promise.resolve({ ok: true, status: 201, json: async () => ({}) } as Response)
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ key: 'ENG-42', status: 'todo' }),
        } as Response)
      }),
    )

    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Unrelated dependency bump')
    await user.type(screen.getByLabelText(/issue key/i), 'eng-42')
    await user.click(screen.getByRole('button', { name: /attach/i }))

    await waitFor(() => {
      // Lower-case input is normalised, so the key is forgiving to type.
      expect(calls).toContain('POST /api/v1/w/lab/issues/ENG-42/prs')
    })
  })

  it('reports a bad issue key instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/pull-requests/unlinked')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ pull_requests: [stray] }),
          } as Response)
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ error: { code: 'not_found', message: 'no such issue' } }),
        } as Response)
      }),
    )

    const user = userEvent.setup()
    renderPage()

    await screen.findByText('Unrelated dependency bump')
    await user.type(screen.getByLabelText(/issue key/i), 'ENG-999')
    await user.click(screen.getByRole('button', { name: /attach/i }))

    expect(await screen.findByText(/no issue with that key/i)).toBeInTheDocument()
  })
})
