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

  it('offers Jev\'s suggestion and links it only when chosen', async () => {
    const calls: string[] = []
    let linked = false
    vi.stubGlobal('fetch', route(calls, (url) => {
      if (url.includes('/pull-requests/unlinked')) {
        return { pull_requests: linked ? [] : [{ ...stray, suggestion }] }
      }
      if (url.includes('/suggestions/sg1/accept')) {
        linked = true
        return { issue_key: 'ENG-7' }
      }
      return undefined
    }))

    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('Suggested issue:')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'ENG-7' })).toHaveAttribute('href', '/w/lab/issues/ENG-7')
    expect(screen.getByText('Cache the workspace lookup')).toBeInTheDocument()
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Link to ENG-7' }))
    await waitFor(() => expect(calls).toContain('POST /api/v1/w/lab/suggestions/sg1/accept'))
    expect(await screen.findByText(/nothing unlinked/i)).toBeInTheDocument()
  })

  it('dismisses a suggestion and keeps the manual key field', async () => {
    const calls: string[] = []
    let dismissed = false
    vi.stubGlobal('fetch', route(calls, (url) => {
      if (url.includes('/pull-requests/unlinked')) {
        return { pull_requests: [{ ...stray, suggestion: dismissed ? null : suggestion }] }
      }
      if (url.includes('/suggestions/sg1/dismiss')) {
        dismissed = true
        return null
      }
      return undefined
    }))

    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Dismiss suggestion ENG-7' }))
    await waitFor(() => expect(screen.queryByText('Suggested issue:')).toBeNull())
    expect(calls).toContain('POST /api/v1/w/lab/suggestions/sg1/dismiss')
    expect(screen.getByLabelText(/issue key/i)).toBeInTheDocument()
  })

  it('lists project notes with a suggested issue', async () => {
    vi.stubGlobal('fetch', route([], (url) => {
      if (url.includes('/pull-requests/unlinked')) return { pull_requests: [] }
      if (url.includes('/suggestions/notes')) {
        return {
          notes: [{
            comment: {
              id: 'c1', workspace_id: 'w1', target_type: 'project', target_id: 'p1', parent_id: null,
              author: { id: 'u1', email: '', github_id: null, github_login: null, name: 'Sabari', avatar_url: '' },
              body: 'Cached the resolved workspace.', source: 'agent', kind: 'progress',
              created_at: new Date().toISOString(), edited_at: null, deleted_at: null,
            },
            project_key: 'velvet',
            project_name: 'Velvet',
            suggestion,
          }],
        }
      }
      return undefined
    }))

    renderPage()
    expect(await screen.findByRole('heading', { name: 'Notes that may belong on an issue' })).toBeInTheDocument()
    expect(screen.getByText('Cached the resolved workspace.')).toBeInTheDocument()
    expect(screen.getByText('Agent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'File under ENG-7' })).toBeInTheDocument()
  })

  it('hides linking controls from viewers', async () => {
    vi.stubGlobal('fetch', route([], (url) => {
      if (url.endsWith('/me')) return session('viewer')
      if (url.includes('/pull-requests/unlinked')) return { pull_requests: [{ ...stray, suggestion }] }
      return undefined
    }))

    renderPage()
    expect(await screen.findByText('Suggested issue:')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: /link to/i })).toBeNull())
    expect(screen.queryByLabelText(/issue key/i)).toBeNull()
  })
})

const suggestion = {
  id: 'sg1',
  issue_key: 'ENG-7',
  issue_title: 'Cache the workspace lookup',
  issue_status: 'todo',
  probability: 0.9,
}

function session(role: 'admin' | 'viewer') {
  return {
    user: { id: 'u1', email: 'a@b.c', github_id: null, github_login: null, name: 'Sabari', avatar_url: '' },
    memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role }],
    last_workspace: null,
  }
}

/**
 * Answers fetches by URL. The handler returns a JSON body, null for a 204, or
 * undefined to fall through to defaults: an admin session and no notes.
 */
function route(calls: string[], handler: (url: string) => unknown) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    let body = handler(url)
    if (body === undefined) {
      if (url.endsWith('/me')) body = session('admin')
      else if (url.includes('/suggestions/notes')) body = { notes: [] }
      else body = {}
    }
    if (body === null) return Promise.resolve({ ok: true, status: 204, json: async () => ({}) } as Response)
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  })
}
