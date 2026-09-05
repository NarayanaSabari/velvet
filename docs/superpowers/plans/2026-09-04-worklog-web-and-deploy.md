# Work-Log Ticketing System - Web App and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React SPA - dashboard, team feed, sprint board, milestone and issue pages with comments and PR evidence - plus the reports the spec asks for, and the Docker Compose deployment that runs the whole system.

**Architecture:** A Vite-built React SPA talking to the Go API over cookie-authenticated JSON. TanStack Query owns all server state; there is no second client-side store to fall out of sync with it. Live updates arrive on the existing SSE stream and invalidate query caches rather than patching state by hand. Caddy serves the built assets and proxies the API, so the browser sees one origin and cookies need no cross-site handling.

**Tech Stack:** React 19, TypeScript, Vite, TanStack Query v5, TanStack Router, Tailwind CSS v4, Vitest, Playwright, Caddy, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-04-worklog-ticketing-design.md`, sections 6, 7, 8, 10, 11.

**Depends on:** the core API plan (all tasks) and the GitHub integration plan (all tasks).

## Global Constraints

- **Monochrome.** Black on white, greys for structure, no brand colour. Exactly three semantic colours exist: red for destructive or blocked, amber for stale, green for merged or done, and each appears only where it carries information the layout cannot. Everything else is `black`, `white`, or a grey from the scale.
- No gradients, no illustrations, no shadowed cards. Hairline 1px borders only. No animation beyond instant state changes and a hover transition.
- Dark mode inverts the same palette and is the only theme variation.
- The Tailwind theme defines a deliberately narrow token set, so the constraint is enforced by the available classes rather than by discipline. Adding a colour token requires changing the theme, which is a visible diff.
- All server state goes through TanStack Query. Never mirror server data into `useState`.
- Every list is keyboard navigable: `j`/`k` to move, `Enter` to open, `Escape` to close.
- TypeScript `strict` is on. No `any` in application code.
- Never commit a `.env`. Compose reads secrets from the environment.
- Commit after every task. Never add tool attribution or `Co-Authored-By` trailers to commit messages.

---

### Task 1: Web scaffold, design tokens, and the API client

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/index.css`, `web/src/lib/api.ts`, `web/src/lib/api.test.ts`, `web/src/lib/query.ts`, `web/.gitignore`

**Interfaces:**
- Consumes: the Go API at `/api/v1`.
- Produces:
  - `api.get<T>(path: string): Promise<T>`, `api.post<T>(path, body): Promise<T>`, `api.patch<T>`, `api.put<T>`, `api.del(path)`.
  - `class ApiError extends Error { status: number; code: string }` - thrown for any non-2xx, carrying the API's error `code`.
  - `queryClient` configured with `retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2`.

- [ ] **Step 1: Scaffold the project**

```bash
cd /Users/sabari/Developer/narayana/velvet-otter-lab
npm create vite@latest web -- --template react-ts
cd web
npm install
npm install @tanstack/react-query @tanstack/react-router
npm install -D tailwindcss @tailwindcss/vite vitest @vitest/coverage-v8 \
  @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

- [ ] **Step 2: Configure Vite with the API proxy**

`web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Same-origin in dev as in production, so the session cookie behaves
    // identically in both and no CORS handling is ever needed.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/webhooks': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
  },
})
```

`web/src/test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 3: Define the design tokens**

`web/src/index.css`:

```css
@import "tailwindcss";

/* The whole palette. Adding to this list is a visible diff, which is the
   point: the monochrome constraint is enforced by what exists, not by
   remembering to be disciplined. */
@theme {
  --color-ink: #000000;
  --color-paper: #ffffff;
  --color-grey-100: #f5f5f5;
  --color-grey-200: #e5e5e5;
  --color-grey-300: #d4d4d4;
  --color-grey-500: #737373;
  --color-grey-700: #404040;

  /* Semantic, and only semantic. Never decoration. */
  --color-blocked: #b91c1c;
  --color-stale: #b45309;
  --color-done: #15803d;

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;

  --text-xs: 0.75rem;
  --text-sm: 0.8125rem;
  --text-base: 0.875rem;
  --text-lg: 1.125rem;
}

@layer base {
  html {
    color-scheme: light dark;
  }

  body {
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    -webkit-font-smoothing: antialiased;
  }

  /* Dark mode inverts the same palette rather than introducing a second one. */
  @media (prefers-color-scheme: dark) {
    :root {
      --color-ink: #ffffff;
      --color-paper: #0a0a0a;
      --color-grey-100: #171717;
      --color-grey-200: #262626;
      --color-grey-300: #404040;
      --color-grey-500: #a3a3a3;
      --color-grey-700: #d4d4d4;
      --color-blocked: #f87171;
      --color-stale: #fbbf24;
      --color-done: #4ade80;
    }
  }

  /* Focus must always be visible: the app is keyboard-first. */
  :focus-visible {
    outline: 2px solid var(--color-ink);
    outline-offset: 1px;
  }
}
```

- [ ] **Step 4: Write the failing API client test**

`web/src/lib/api.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest'
import { api, ApiError } from './api'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(status: number, body: unknown, ok = status < 400) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as Response)
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('api', () => {
  it('sends credentials so the session cookie is included', async () => {
    const spy = stubFetch(200, { status: 'ok' })
    await api.get('/health')
    expect(spy).toHaveBeenCalledWith(
      '/api/v1/health',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('throws ApiError carrying the API error code', async () => {
    stubFetch(403, { error: { code: 'forbidden', message: 'insufficient permission' } })
    await expect(api.get('/w/lab/issues')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
  })

  it('surfaces a non-JSON failure rather than hanging', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('not json') },
    } as unknown as Response))

    const err = await api.get('/health').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(502)
  })

  it('returns undefined for a 204 rather than parsing an empty body', async () => {
    stubFetch(204, undefined)
    await expect(api.del('/w/lab/comments/1')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd web && npx vitest run src/lib/api.test.ts`
Expected: FAIL - `./api` does not exist.

- [ ] **Step 6: Implement the client**

`web/src/lib/api.ts`:

```ts
const BASE = '/api/v1'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    // The session lives in an HttpOnly cookie; the SPA never holds a token.
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
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
  del: (path: string) => request<void>('DELETE', path),
}
```

`web/src/lib/query.ts`:

```ts
import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Retrying a 4xx just repeats a client mistake; only server faults and
      // network failures are worth another attempt.
      retry: (count, error) =>
        !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
})
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: PASS, all four tests, and no type errors.

- [ ] **Step 8: Commit**

```bash
git add web
git commit -m "Add web scaffold, monochrome design tokens, and API client"
```

---

### Task 2: Shared UI primitives

**Files:**
- Create: `web/src/ui/Button.tsx`, `web/src/ui/StatusBadge.tsx`, `web/src/ui/Avatar.tsx`, `web/src/ui/EmptyState.tsx`, `web/src/ui/Markdown.tsx`, `web/src/ui/RelativeTime.tsx`, `web/src/ui/List.tsx`, `web/src/ui/ui.test.tsx`
- Install: `npm i marked dompurify`

**Interfaces:**
- Consumes: design tokens.
- Produces:
  - `<Button variant="primary" | "ghost" | "danger">`
  - `<StatusBadge status={IssueStatus} />` - text plus position, never colour alone.
  - `<Avatar user={User} size="sm" | "md" />`
  - `<EmptyState title message action? />`
  - `<Markdown source={string} />` - sanitised.
  - `<RelativeTime iso={string} />` - "3 hours ago", with the absolute time in `title`.
  - `<List items keyExtractor renderItem onActivate />` - the keyboard-navigable list every view uses.

- [ ] **Step 1: Write the failing test**

`web/src/ui/ui.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { StatusBadge } from './StatusBadge'
import { Markdown } from './Markdown'
import { RelativeTime } from './RelativeTime'
import { List } from './List'

describe('StatusBadge', () => {
  it('names the status in text, never colour alone', () => {
    render(<StatusBadge status="in_progress" />)
    expect(screen.getByText('In progress')).toBeInTheDocument()
  })
})

describe('Markdown', () => {
  it('renders formatting', () => {
    render(<Markdown source="**bold** and `code`" />)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
  })

  it('strips a script tag rather than trusting comment bodies', () => {
    const { container } = render(
      <Markdown source={'before <script>window.pwned = 1</script> after'} />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('before')
  })

  it('strips a javascript: href', () => {
    const { container } = render(
      <Markdown source={'[click](javascript:alert(1))'} />,
    )
    const link = container.querySelector('a')
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:')
  })
})

describe('RelativeTime', () => {
  it('shows a relative label and the exact time on hover', () => {
    const iso = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    render(<RelativeTime iso={iso} />)
    const el = screen.getByText(/hours ago/)
    expect(el).toHaveAttribute('title', expect.stringContaining('20'))
  })
})

describe('List', () => {
  const items = [
    { id: 'a', label: 'First' },
    { id: 'b', label: 'Second' },
    { id: 'c', label: 'Third' },
  ]

  it('moves with j and k and activates with Enter', async () => {
    const onActivate = vi.fn()
    const user = userEvent.setup()

    render(
      <List
        items={items}
        keyExtractor={(i) => i.id}
        renderItem={(i) => <span>{i.label}</span>}
        onActivate={onActivate}
      />,
    )

    await user.tab()
    await user.keyboard('j')
    await user.keyboard('{Enter}')
    expect(onActivate).toHaveBeenCalledWith(items[1])
  })

  it('does not move past the ends', async () => {
    const onActivate = vi.fn()
    const user = userEvent.setup()

    render(
      <List
        items={items}
        keyExtractor={(i) => i.id}
        renderItem={(i) => <span>{i.label}</span>}
        onActivate={onActivate}
      />,
    )

    await user.tab()
    await user.keyboard('kkk')
    await user.keyboard('{Enter}')
    expect(onActivate).toHaveBeenCalledWith(items[0])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/ui`
Expected: FAIL - components do not exist.

- [ ] **Step 3: Implement the primitives**

`web/src/ui/Markdown.tsx` must sanitise. Comment bodies are user input rendered to other users, so this is the one place in the SPA where a mistake is a security bug rather than a visual one:

```tsx
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useMemo } from 'react'

export function Markdown({ source }: { source: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false }) as string),
    [source],
  )
  return (
    <div
      className="prose-none [&_a]:underline [&_code]:bg-grey-100 [&_code]:px-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
```

`StatusBadge` maps status to a human label and a border, with colour only on `done` (green) and never as the sole signal:

```tsx
const LABELS: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
}
```

`List` owns the roving focus index, binds `j`/`k`/`Enter`, and sets `aria-activedescendant`. It must not scroll the page when the user presses `j` at the bottom of a list; call `preventDefault` on handled keys only.

Every other primitive is plain markup with token classes: 1px borders, no shadows, no gradients.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run src/ui && npx tsc --noEmit`
Expected: PASS, all six tests.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "Add monochrome UI primitives with sanitised markdown and keyboard lists"
```

---

### Task 3: Routing, session, and the app shell

**Files:**
- Create: `web/src/routes/root.tsx`, `web/src/routes/router.tsx`, `web/src/features/auth/useSession.ts`, `web/src/features/auth/SignIn.tsx`, `web/src/features/auth/NotInvited.tsx`, `web/src/app/Shell.tsx`, `web/src/app/shell.test.tsx`
- Modify: `web/src/main.tsx`

**Interfaces:**
- Consumes: `api`, `queryClient`.
- Produces:
  - `useSession(): { user, memberships, workspace, isLoading, isSignedIn }` backed by `GET /me`.
  - Routes: `/` redirects to `/w/{firstSlug}`, then `/w/{slug}` dashboard, `/w/{slug}/feed`, `/w/{slug}/sprints`, `/w/{slug}/sprints/{id}`, `/w/{slug}/milestones/{id}`, `/w/{slug}/issues/{key}`, `/w/{slug}/unlinked`, `/w/{slug}/reports`, `/signin`, `/not-invited`.
  - `<Shell>` - left nav, workspace switcher, sign-out.

- [ ] **Step 1: Write the failing test**

`web/src/app/shell.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/app`
Expected: FAIL - `Shell` does not exist.

- [ ] **Step 3: Implement session and shell**

`useSession` wraps `useQuery({ queryKey: ['session'], queryFn: () => api.get<SessionPayload>('/me') })`. A 401 is a normal state, not an error to retry, so `retry: false` on this query specifically.

`Shell` renders nothing session-dependent while `isLoading`, which is what stops the sign-in prompt flashing on every refresh.

`SignIn` is a plain anchor to `/api/v1/auth/github/login`, not a fetch: OAuth needs a real navigation.

The nav lists Dashboard, Team feed, Sprints, Unlinked PRs, and Reports, in that order, as plain text links with a 1px right border on the sidebar.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "Add routing, session handling, and the app shell"
```

---

### Task 4: Dashboard and team feed

**Files:**
- Create: `web/src/features/activity/ActivityRow.tsx`, `web/src/features/activity/useActivity.ts`, `web/src/features/dashboard/Dashboard.tsx`, `web/src/features/feed/TeamFeed.tsx`, `web/src/features/activity/activity.test.tsx`, `web/src/lib/useStream.ts`

**Interfaces:**
- Consumes: `GET /w/{slug}/dashboard`, `GET /w/{slug}/activity`, `GET /w/{slug}/stream`.
- Produces:
  - `useActivity(slug, filters)` - infinite query paging on `next_cursor`.
  - `useStream(slug)` - subscribes to SSE and invalidates the `activity` and `dashboard` query keys on each event.
  - `<ActivityRow activity />` - renders one row per verb.

- [ ] **Step 1: Write the failing test**

`web/src/features/activity/activity.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { ActivityRow } from './ActivityRow'
import type { Activity } from '../../lib/types'

const actor = { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' }

function row(overrides: Partial<Activity>): Activity {
  return {
    id: 1,
    workspace_id: 'w1',
    actor,
    verb: 'commented',
    target_type: 'issue',
    target_id: 'i1',
    metadata: {},
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('ActivityRow', () => {
  it('describes a comment with its excerpt', () => {
    render(<ActivityRow activity={row({
      verb: 'commented',
      metadata: { key: 'ENG-1', excerpt: 'Started on this today' },
    })} />)
    expect(screen.getByText(/commented/i)).toBeInTheDocument()
    expect(screen.getByText(/Started on this today/)).toBeInTheDocument()
  })

  it('describes a status change with both states', () => {
    render(<ActivityRow activity={row({
      verb: 'changed_status',
      metadata: { key: 'ENG-1', from: 'todo', to: 'in_progress' },
    })} />)
    expect(screen.getByText(/Todo/)).toBeInTheDocument()
    expect(screen.getByText(/In progress/)).toBeInTheDocument()
  })

  it('describes an attached PR as evidence', () => {
    render(<ActivityRow activity={row({
      verb: 'attached_pr',
      metadata: { key: 'ENG-1', number: 42 },
    })} />)
    expect(screen.getByText(/#42/)).toBeInTheDocument()
  })

  it('renders an unknown verb without crashing', () => {
    render(<ActivityRow activity={row({ verb: 'invented_verb', metadata: {} })} />)
    expect(screen.getByText(/sabari/i)).toBeInTheDocument()
  })

  it('survives a deleted actor', () => {
    render(<ActivityRow activity={row({ actor: null, verb: 'commented' })} />)
    expect(screen.getByText(/someone/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/features/activity`
Expected: FAIL - component does not exist.

- [ ] **Step 3: Implement the feed**

`ActivityRow` switches on `verb` with a default branch that renders a generic sentence. An unknown verb must never crash the feed: the API can add verbs before the SPA knows them, and a blank feed is a far worse failure than a vague row.

`actor` is nullable because the column is `ON DELETE SET NULL`; render "Someone" rather than crashing.

`useStream` opens `new EventSource('/api/v1/w/' + slug + '/stream')`, and on each `activity` event calls `queryClient.invalidateQueries({ queryKey: ['activity', slug] })` and the same for `['dashboard', slug]`. Invalidating rather than patching means the server stays the single source of truth and a dropped event costs one refresh, not a wrong screen. Close the source on unmount.

`Dashboard` renders, in order: the current sprint's milestones with the caller's share, their open issues grouped by milestone, unread mentions, and their recent activity.

`TeamFeed` renders the unfiltered stream with filter controls for person, milestone, and verb.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "Add dashboard, team feed, and SSE-driven cache invalidation"
```

---

### Task 5: Sprint, milestone, and issue views

**Files:**
- Create: `web/src/features/sprints/SprintList.tsx`, `web/src/features/sprints/SprintBoard.tsx`, `web/src/features/milestones/MilestonePage.tsx`, `web/src/features/issues/IssuePage.tsx`, `web/src/features/issues/IssueList.tsx`, `web/src/features/issues/StatusSelect.tsx`, `web/src/features/comments/CommentThread.tsx`, `web/src/features/comments/CommentComposer.tsx`, `web/src/features/evidence/EvidenceCard.tsx`, and their tests

**Interfaces:**
- Consumes: the sprint, milestone, issue, comment, and evidence endpoints.
- Produces: the five views the spec's section 6 describes.

- [ ] **Step 1: Write the failing tests**

`web/src/features/sprints/sprintBoard.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { MilestoneRow } from './SprintBoard'

const base = {
  id: 'm1',
  workspace_id: 'w1',
  sprint_id: 's1',
  name: 'Ship auth',
  description: '',
  owner_id: null,
  target_date: null,
  status: 'in_progress' as const,
  position: 'V',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

describe('MilestoneRow', () => {
  it('shows counts and the latest comment, because the comment carries more', () => {
    render(<MilestoneRow milestone={{
      ...base,
      issue_counts: { done: 3, in_progress: 5 },
      last_comment: {
        id: 'c1',
        body: 'Blocked on vendor access',
        created_at: new Date().toISOString(),
      },
    }} />)

    expect(screen.getByText('3/8')).toBeInTheDocument()
    expect(screen.getByText(/Blocked on vendor access/)).toBeInTheDocument()
  })

  it('marks a silent milestone as stale rather than leaving it looking healthy', () => {
    const threeWeeksAgo = new Date(Date.now() - 21 * 864e5).toISOString()
    render(<MilestoneRow milestone={{
      ...base,
      issue_counts: { in_progress: 4 },
      last_comment: { id: 'c1', body: 'Starting', created_at: threeWeeksAgo },
    }} />)

    expect(screen.getByText(/no update in 21 days/i)).toBeInTheDocument()
  })

  it('handles a milestone with no comments at all', () => {
    render(<MilestoneRow milestone={{ ...base, issue_counts: {}, last_comment: null }} />)
    expect(screen.getByText(/no updates yet/i)).toBeInTheDocument()
  })
})
```

`web/src/features/issues/issuePage.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { IssueTimeline } from './IssuePage'
import { EvidenceCard } from '../evidence/EvidenceCard'

describe('IssueTimeline', () => {
  it('interleaves comments, status changes, and PRs in time order', () => {
    render(<IssueTimeline entries={[
      { kind: 'comment', id: 'c1', at: '2026-09-01T10:00:00Z', body: 'Starting', author: null },
      { kind: 'status', id: 's1', at: '2026-09-01T11:00:00Z', from: 'todo', to: 'in_progress' },
      { kind: 'pr', id: 'p1', at: '2026-09-01T12:00:00Z', number: 42, state: 'merged' },
    ]} />)

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Starting')
    expect(items[2]).toHaveTextContent('#42')
  })
})

describe('EvidenceCard', () => {
  it('prompts rather than auto-completing when a PR merges', async () => {
    const onMarkDone = vi.fn()
    const user = userEvent.setup()

    render(<EvidenceCard
      pr={{
        id: 'p1', number: 42, title: 'Fix auth', state: 'merged', draft: false,
        author_login: 'sabari', additions: 10, deletions: 2,
        html_url: 'https://github.com/acme/widgets/pull/42',
        merged_at: '2026-09-01T12:00:00Z',
      }}
      issueStatus="in_progress"
      onMarkDone={onMarkDone}
    />)

    const prompt = screen.getByRole('button', { name: /mark .* done/i })
    expect(prompt).toBeInTheDocument()
    expect(onMarkDone).not.toHaveBeenCalled()

    await user.click(prompt)
    expect(onMarkDone).toHaveBeenCalledOnce()
  })

  it('does not prompt when the issue is already done', () => {
    render(<EvidenceCard
      pr={{
        id: 'p1', number: 42, title: 'Fix auth', state: 'merged', draft: false,
        author_login: 'sabari', additions: 10, deletions: 2,
        html_url: '#', merged_at: '2026-09-01T12:00:00Z',
      }}
      issueStatus="done"
      onMarkDone={vi.fn()}
    />)

    expect(screen.queryByRole('button', { name: /mark .* done/i })).toBeNull()
  })

  it('shows the diff size and merge state as evidence', () => {
    render(<EvidenceCard
      pr={{
        id: 'p1', number: 42, title: 'Fix auth', state: 'merged', draft: false,
        author_login: 'sabari', additions: 10, deletions: 2,
        html_url: '#', merged_at: '2026-09-01T12:00:00Z',
      }}
      issueStatus="done"
      onMarkDone={vi.fn()}
    />)

    expect(screen.getByText('+10')).toBeInTheDocument()
    expect(screen.getByText('-2')).toBeInTheDocument()
    expect(screen.getByText(/merged/i)).toBeInTheDocument()
  })
})
```

`web/src/features/comments/commentThread.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CommentComposer } from './CommentComposer'

describe('CommentComposer', () => {
  it('submits on Cmd+Enter', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    await user.type(screen.getByRole('textbox'), 'Progress update')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onSubmit).toHaveBeenCalledWith('Progress update')
  })

  it('refuses an empty body', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    await user.type(screen.getByRole('textbox'), '   ')
    await user.click(screen.getByRole('button', { name: /comment/i }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the draft when submission fails, so nobody loses their writing', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    const box = screen.getByRole('textbox')
    await user.type(box, 'A long update worth keeping')
    await user.click(screen.getByRole('button', { name: /comment/i }))

    expect(box).toHaveValue('A long update worth keeping')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/features`
Expected: FAIL - components do not exist.

- [ ] **Step 3: Implement the views**

`MilestoneRow` computes `done/total` from `issue_counts`, and marks the milestone stale in amber when the newest comment is older than 14 days or there is none. Staleness is shown as words plus colour, never colour alone.

`IssuePage` merges comments, status changes, commits, PRs, and reviews into one array sorted by timestamp, then renders `IssueTimeline`.

`EvidenceCard` shows the prompt only when the PR is merged and the issue is not already `done` or `cancelled`. Clicking it calls the ordinary status mutation. **The card never changes status on its own.**

`CommentComposer` clears its draft only after `onSubmit` resolves. Clearing optimistically loses a long update the moment the network hiccups.

`StatusSelect` is a plain `<select>` with the six statuses. Native controls are keyboard accessible for free and match the minimal aesthetic.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: PASS, all ten tests.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "Add sprint board, milestone and issue pages, comments, and evidence cards"
```

---

### Task 6: Reports

**Files:**
- Create: `api/internal/store/report.go`, `api/internal/api/report.go`, `api/internal/api/report_test.go`, `web/src/features/reports/Reports.tsx`, `web/src/features/reports/reports.test.tsx`
- Modify: `api/internal/api/server.go`

**Interfaces:**
- Produces:
  - `(*Store).PersonActivity(ctx, workspaceID uuid.UUID, from, to string) ([]PersonActivityRow, error)`
  - `(*Store).MilestoneCompletion(ctx, workspaceID uuid.UUID) ([]MilestoneCompletionRow, error)`
  - `(*Store).IssuesClosedPerSprint(ctx, workspaceID uuid.UUID) ([]SprintClosedRow, error)`
  - `(*Store).StaleIssues(ctx, workspaceID uuid.UUID, days int) ([]StaleIssueRow, error)`
- Routes: `GET /api/v1/w/{slug}/reports/activity`, `/milestones`, `/closed`, `/stale`.

- [ ] **Step 1: Write the failing API test**

`api/internal/api/report_test.go`:

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestStaleReportFindsSilentInProgressWork(t *testing.T) {
	f := testutil.NewFixture(t)

	fresh := createIssue(t, f, map[string]any{"title": "Fresh", "status": "in_progress"})
	stale := createIssue(t, f, map[string]any{"title": "Stale", "status": "in_progress"})
	createIssue(t, f, map[string]any{"title": "Done thing", "status": "done"})

	// Age the stale issue's activity past the threshold.
	_, err := f.Pool.Exec(t.Context(), `
		UPDATE activity SET created_at = now() - interval '30 days'
		WHERE target_id = $1`, stale.ID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `
		UPDATE issue SET updated_at = now() - interval '30 days' WHERE id = $1`, stale.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/reports/stale?days=14", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var out struct {
		Issues []store.StaleIssueRow `json:"issues"`
	}
	f.DecodeInto(rec, &out)
	require.Len(t, out.Issues, 1)
	require.Equal(t, stale.Key, out.Issues[0].Key)
	require.NotEqual(t, fresh.Key, out.Issues[0].Key)
}

func TestStaleReportIgnoresDoneAndCancelled(t *testing.T) {
	f := testutil.NewFixture(t)
	old := createIssue(t, f, map[string]any{"title": "Old but done", "status": "done"})

	_, err := f.Pool.Exec(t.Context(), `
		UPDATE issue SET updated_at = now() - interval '90 days' WHERE id = $1`, old.ID)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/reports/stale?days=14", nil)
	var out struct {
		Issues []store.StaleIssueRow `json:"issues"`
	}
	f.DecodeInto(rec, &out)
	require.Empty(t, out.Issues, "finished work is not stalled work")
}

func TestPersonActivityCountsPerMember(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := createIssue(t, f, map[string]any{"title": "Ship it"})
	require.Equal(t, http.StatusCreated,
		f.Do(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/comments",
			map[string]any{"body": "An update"}).Code)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/reports/activity", nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var out struct {
		People []store.PersonActivityRow `json:"people"`
	}
	f.DecodeInto(rec, &out)
	require.Len(t, out.People, 1)
	require.Equal(t, "sabari", out.People[0].GitHubLogin)
	require.GreaterOrEqual(t, out.People[0].Total, 2)
}

func TestReportsAreWorkspaceScoped(t *testing.T) {
	f := testutil.NewFixture(t)

	var otherWS string
	require.NoError(t, f.Pool.QueryRow(t.Context(),
		`INSERT INTO workspace (name, slug) VALUES ('Other', 'other') RETURNING id`).Scan(&otherWS))
	_, err := f.Pool.Exec(t.Context(), `
		INSERT INTO issue (workspace_id, key, number, title, position, status)
		VALUES ($1, 'ENG-1', 1, 'Foreign stale', 'V', 'in_progress')`, otherWS)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(),
		`UPDATE issue SET updated_at = now() - interval '90 days' WHERE workspace_id = $1`, otherWS)
	require.NoError(t, err)

	rec := f.Do(http.MethodGet, "/api/v1/w/lab/reports/stale?days=14", nil)
	require.NotContains(t, rec.Body.String(), "Foreign stale")
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run Report`
Expected: FAIL - routes not found.

- [ ] **Step 3: Implement the reports**

`StaleIssues` selects issues in `in_progress` or `in_review` whose most recent signal - the newest of `issue.updated_at`, the newest related `activity.created_at`, and the newest linked PR's `gh_updated_at` - is older than `days`. Using the newest of the three is what keeps the report honest: an issue with a PR pushed yesterday is not stalled just because nobody commented.

`PersonActivity` groups `activity` by actor over an optional date range, returning the verb breakdown and a total.

`MilestoneCompletion` and `IssuesClosedPerSprint` are straightforward group-bys over milestone status and issue status per sprint.

- [ ] **Step 4: Write the failing web test**

`web/src/features/reports/reports.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { StaleTable } from './Reports'

describe('StaleTable', () => {
  it('says how long each issue has been silent', () => {
    render(<StaleTable rows={[
      { id: 'i1', key: 'ENG-1', title: 'Stuck thing', status: 'in_progress', days_silent: 21, assignee_login: 'sabari' },
    ]} />)

    expect(screen.getByText('ENG-1')).toBeInTheDocument()
    expect(screen.getByText(/21 days/)).toBeInTheDocument()
  })

  it('says so plainly when nothing is stale', () => {
    render(<StaleTable rows={[]} />)
    expect(screen.getByText(/nothing has stalled/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 5: Implement the reports page**

Four plain tables, no charts. Numbers in a monochrome table are read faster than a chart at this scale, and a chart would need colour the design does not have. Amber marks a stale row, alongside the day count in words.

- [ ] **Step 6: Run everything and verify it passes**

Run: `cd api && go test -count=1 ./... && cd ../web && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api web
git commit -m "Add reports: person activity, milestone completion, closed per sprint, staleness"
```

---

### Task 7: Sprint snapshot on close

**Files:**
- Create: `api/internal/db/migrations/0003_sprint_snapshot.sql`, `api/internal/store/snapshot.go`, `api/internal/api/snapshot_test.go`
- Modify: `api/internal/store/sprint.go`

**Interfaces:**
- Produces:
  - `(*Store).CloseSprint` extended to write a `sprint_snapshot` row and roll incomplete issues forward.
  - `(*Store).GetSnapshot(ctx, workspaceID, sprintID uuid.UUID) (SprintSnapshot, error)`
- Route: `GET /api/v1/w/{slug}/sprints/{id}/snapshot`.

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE sprint_snapshot (
    sprint_id            uuid PRIMARY KEY REFERENCES sprint(id) ON DELETE CASCADE,
    workspace_id         uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    milestones_planned   integer NOT NULL,
    milestones_completed integer NOT NULL,
    issue_counts         jsonb NOT NULL,
    person_totals        jsonb NOT NULL,
    captured_at          timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Write the failing test**

`api/internal/api/snapshot_test.go`:

```go
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
)

func TestClosingASprintFreezesItsNumbers(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/activate", nil).Code)

	rec := f.Do(http.MethodPost,
		"/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	issue := createIssue(t, f, map[string]any{
		"title": "Work", "milestone_id": m.ID.String(), "status": "done"})

	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/close", nil).Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/snapshot", nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var snap store.SprintSnapshot
	f.DecodeInto(rec, &snap)
	require.Equal(t, 1, snap.MilestonesPlanned)
	require.Equal(t, 1, snap.IssueCounts["done"])

	// Editing history after the close must not change the frozen report.
	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPatch, "/api/v1/w/lab/issues/"+issue.Key,
			map[string]any{"status": "cancelled"}).Code)

	rec = f.Do(http.MethodGet, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/snapshot", nil)
	f.DecodeInto(rec, &snap)
	require.Equal(t, 1, snap.IssueCounts["done"],
		"a later edit must not silently rewrite last month's report")
}

func TestIncompleteIssuesRollForward(t *testing.T) {
	f := testutil.NewFixture(t)

	sept := newSprint(t, f)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints", map[string]any{
		"name": "October", "starts_on": "2026-10-01", "ends_on": "2026-10-31"})
	var oct store.Sprint
	f.DecodeInto(rec, &oct)

	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sept.ID.String()+"/activate", nil).Code)

	rec = f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sept.ID.String()+"/milestones",
		map[string]any{"name": "Ship auth"})
	var m store.Milestone
	f.DecodeInto(rec, &m)

	unfinished := createIssue(t, f, map[string]any{
		"title": "Not done", "milestone_id": m.ID.String(), "status": "in_progress"})

	require.Equal(t, http.StatusOK,
		f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sept.ID.String()+"/close", nil).Code)

	// The issue must still be reachable and still open, now under October.
	rec = f.Do(http.MethodGet, "/api/v1/w/lab/issues/"+unfinished.Key, nil)
	require.Equal(t, http.StatusOK, rec.Code)

	var got store.Issue
	f.DecodeInto(rec, &got)
	require.Equal(t, "in_progress", got.Status,
		"rolling forward must not silently complete or cancel work")
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd api && go test ./internal/api/ -run Snapshot`
Expected: FAIL - route not found.

- [ ] **Step 4: Implement it**

Extend `CloseSprint` to capture the snapshot and roll incomplete issues into the next `upcoming` sprint's milestones, all inside the existing transaction. When no upcoming sprint exists, leave the issues where they are rather than inventing a sprint.

- [ ] **Step 5: Run the tests and commit**

```bash
cd api && go test -count=1 ./...
git add api
git commit -m "Freeze sprint snapshot on close and roll incomplete issues forward"
```

---

### Task 8: Docker Compose deployment

**Files:**
- Create: `Dockerfile.api`, `web/Dockerfile`, `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`, `deploy/backup.sh`, `README.md` (rewrite)

**Interfaces:**
- Produces: a working `docker compose up` bringing up long-lived `caddy`, `api`, `worker`, and `postgres` containers, plus the one-shot `migrate` and `web` services.

- [ ] **Step 1: Write the API Dockerfile**

`Dockerfile.api`:

```dockerfile
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY api/go.mod api/go.sum ./
RUN go mod download
COPY api/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ticket ./cmd/ticket

FROM alpine:3.21
RUN adduser -D -u 10001 ticket && apk add --no-cache ca-certificates
COPY --from=build /out/ticket /usr/local/bin/ticket
USER ticket
ENTRYPOINT ["ticket"]
CMD ["serve"]
```

The binary runs as a non-root user with no shell in the final image, so a compromised process has nothing to work with.

- [ ] **Step 2: Write the web Dockerfile**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /src
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM alpine:3.21 AS assets
COPY --from=build /src/dist /dist
```

- [ ] **Step 3: Write the Compose file**

`deploy/docker-compose.yml`:

```yaml
name: worklog

services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:?set POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-worklog}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  migrate:
    build:
      context: ..
      dockerfile: Dockerfile.api
    command: ["migrate"]
    environment:
      DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  api:
    build:
      context: ..
      dockerfile: Dockerfile.api
    command: ["serve"]
    environment:
      DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}
      BASE_URL: ${BASE_URL:?set BASE_URL}
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET}
      GITHUB_WEBHOOK_SECRET: ${GITHUB_WEBHOOK_SECRET}
      GITHUB_APP_ID: ${GITHUB_APP_ID}
      GITHUB_APP_PRIVATE_KEY: ${GITHUB_APP_PRIVATE_KEY}
    depends_on:
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped

  worker:
    build:
      context: ..
      dockerfile: Dockerfile.api
    command: ["worker"]
    environment:
      DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}
      BASE_URL: ${BASE_URL:?set BASE_URL}
      GITHUB_APP_ID: ${GITHUB_APP_ID}
      GITHUB_APP_PRIVATE_KEY: ${GITHUB_APP_PRIVATE_KEY}
    depends_on:
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped

  web:
    build:
      context: ..
      dockerfile: web/Dockerfile
    volumes:
      - webdist:/dist
    command: ["true"]

  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS:?set SITE_ADDRESS}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - webdist:/srv:ro
      - caddydata:/data
    depends_on:
      - api
      - web
    restart: unless-stopped

volumes:
  pgdata:
  caddydata:
  webdist:
```

Migrations run as a one-shot `migrate` service that both `api` and `worker` wait on, so schema changes apply exactly once rather than racing between two starting containers.

Every required variable uses `${VAR:?message}`, so a missing secret fails the deploy loudly at startup instead of producing a half-configured system.

- [ ] **Step 4: Write the Caddyfile**

```caddyfile
{$SITE_ADDRESS} {
	encode gzip

	handle /api/* {
		reverse_proxy api:8080
	}

	handle /webhooks/* {
		reverse_proxy api:8080
	}

	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}

	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
	}
}
```

`try_files {path} /index.html` is what makes a deep link like `/w/lab/issues/ENG-42` work on a hard refresh instead of 404ing.

- [ ] **Step 5: Write the backup script**

`deploy/backup.sh` runs `pg_dump -Fc`, writes a timestamped file, uploads it if `BACKUP_S3_URL` is set, and prunes local dumps older than 14 days. It must `set -euo pipefail` and exit non-zero on failure, because a backup that fails silently is worse than none.

- [ ] **Step 6: Verify the stack actually comes up**

This is the end-to-end check that the whole plan exists for. Do not skip it and do not simulate it:

```bash
cd deploy
cp .env.example .env.local
# Fill .env.local with local test values. Never commit it.
docker compose --env-file .env.local up -d --build
sleep 20
curl -fsS http://localhost/api/v1/health
docker compose --env-file .env.local ps
docker compose --env-file .env.local down -v
```

Expected: `{"status":"ok"}` from the health check, and every service either running or, for `migrate`, exited 0.

- [ ] **Step 7: Rewrite the README**

Cover: what the system is, the sprint/milestone/issue model, that PRs are evidence and never change status, how to run it locally, how to configure the GitHub App and OAuth app, the environment variables, and how to back up and restore.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile.api web/Dockerfile deploy README.md
git commit -m "Add Docker Compose deployment with Caddy, migrations, and backups"
```

---

### Task 9: End-to-end tests

**Files:**
- Create: `e2e/playwright.config.ts`, `e2e/tests/worklog.spec.ts`, `e2e/fixtures/seed.sql`, `e2e/package.json`

**Interfaces:**
- Produces: a Playwright suite covering the paths the spec names.

- [ ] **Step 1: Configure Playwright**

`e2e/playwright.config.ts` starts the API and the Vite dev server through `webServer`, pointed at a disposable Postgres. Auth is bypassed for tests by seeding a session row directly and setting the cookie, since driving GitHub's OAuth screen in CI would test GitHub rather than this application.

- [ ] **Step 2: Write the end-to-end suite**

`e2e/tests/worklog.spec.ts` covers, as one flow per test:

1. **Sign in and land on the dashboard** - seeded session, dashboard renders with the workspace name.
2. **Create a sprint, a milestone, and an issue** - through the UI, ending on the issue page showing `ENG-1`.
3. **Comment on an issue and see it in the feed** - write a comment, then find it on the team feed. This is the core work-log loop, so it must be exercised end to end rather than in units.
4. **Attach a PR and confirm status does not change** - seed a pull request, attach it from the issue page, assert the evidence card appears and the status is unchanged. This guards the product's central decision.
5. **Close a sprint and read the frozen snapshot** - close it, then edit an issue and confirm the snapshot numbers did not move.
6. **Keyboard navigation** - `j`, `k`, `Enter` moves through the issue list and opens one.

- [ ] **Step 3: Run the suite**

Run: `cd e2e && npx playwright test`
Expected: all six pass. If one fails, fix the application rather than the assertion unless the assertion is genuinely wrong.

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "Add end-to-end tests for the core work-log flows"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 6. My Dashboard | 4 |
| 6. Team Feed | 4 |
| 6. Sprint view with latest comment | 5 |
| 6. Milestone page | 5 |
| 6. Issue page with unified timeline | 5 |
| 6. Unlinked PRs view | 3 (route), 5 (page) |
| 7. Monochrome, three semantic colours, hairline borders | 1 (tokens), 2 (primitives) |
| 7. Dense, keyboard-first | 2 (`List`), 9 (asserted end to end) |
| 7. Dark mode inverts the same palette | 1 |
| 8. Four reports | 6 |
| 4. Sprint snapshot frozen on close | 7 |
| 5. Merge prompts rather than transitions | 5 (`EvidenceCard`, asserted) |
| 10. Testing | every task, plus 9 |
| 11. Delivery, migrations, backups, secrets from the environment | 8 |

**Placeholder scan:** Task 9's Playwright specs are described rather than written out, because each depends on selectors that only exist once tasks 3-5 are built. The six flows and their assertions are named exactly, so nothing is left to invent.

**Type consistency:** `IssueStatus` is one union type in `web/src/lib/types.ts`, used by `StatusBadge`, `StatusSelect`, and `EvidenceCard`. The API's snake_case JSON is used verbatim in the TypeScript types rather than being camelCased, so there is no mapping layer to drift.
