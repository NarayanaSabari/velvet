import type { Issue } from './types'

const BASE = '/api/v1'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    // The session lives in an HttpOnly cookie; the SPA never holds a session token.
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!res.ok) {
    // A proxy or crash can return HTML, so a failed parse must still produce a
    // usable error rather than a confusing SyntaxError from deep in the stack.
    let code = 'unknown'
    let message = `request failed with ${res.status}`
    try {
      const parsed = (await res.json()) as { error?: { code?: string; message?: string } }
      code = parsed.error?.code ?? code
      message = parsed.error?.message ?? message
    } catch {
      // keep the defaults
    }
    throw new ApiError(res.status, code, message)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: (path: string, body?: unknown) => request<void>('DELETE', path, body),
}

interface IssueListPage {
  issues: Issue[]
  next_cursor?: string | null
}

/**
 * The issue endpoint is cursor-paginated for bounded server work.
 * Consumers that need a workspace-wide view must explicitly walk every page
 * rather than assuming the default or maximum limit is the complete result.
 */
export async function listAllWorkspaceIssues(slug: string): Promise<Issue[]> {
  const issues: Issue[] = []
  let cursor = ''

  for (;;) {
    const params = new URLSearchParams({ limit: '200' })
    if (cursor) params.set('cursor', cursor)

    const page = await api.get<IssueListPage>(`/w/${slug}/issues?${params.toString()}`)
    issues.push(...page.issues)

    const nextCursor = page.next_cursor ?? ''
    if (!nextCursor || page.issues.length === 0) return issues
    if (nextCursor === cursor) {
      throw new Error('issue pagination did not advance')
    }
    cursor = nextCursor
  }
}
