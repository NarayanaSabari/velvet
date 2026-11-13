import { expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { TeamFeed } from './TeamFeed'

it('offers every member in the person filter, not only the viewer', async () => {
  const me = { id: 'u1', email: 'asha@example.com', name: 'Asha', github_id: null, github_login: null, avatar_url: '' }
  const bao = { ...me, id: 'u2', email: 'bao@example.com', name: 'Bao' }
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
    const body = input.endsWith('/members') ? { members: [me, bao] }
      : input.includes('/activity') ? { activity: [], next_cursor: null }
        : { user: me, memberships: [{ id: 'm1', workspace_id: 'w1', workspace_slug: 'lab', workspace_name: 'Lab', issue_prefix: 'ENG', role: 'member' }] }
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }))
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TeamFeed slug="lab" />
    </QueryClientProvider>,
  )

  const person = within(screen.getByLabelText('Person'))
  expect(await person.findByRole('option', { name: 'Bao' })).toBeInTheDocument()
  expect(person.getByRole('option', { name: 'Asha' })).toBeInTheDocument()
  expect(person.getByRole('option', { name: 'Everyone' })).toBeInTheDocument()
  vi.unstubAllGlobals()
})
