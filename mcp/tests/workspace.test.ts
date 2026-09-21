import { describe, expect, it, vi } from 'vitest'

import { VelvetApi, type FetchLike } from '../src/api.js'
import type { VelvetConfig } from '../src/types.js'
import { WorkspaceResolver } from '../src/workspace.js'

const baseConfig: VelvetConfig = {
  baseUrl: 'https://worklog.example.com',
  token: 'velvet_test',
  workspace: '',
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('WorkspaceResolver', () => {
  it('resolves the workspace and project from the checkout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ workspace_slug: 'client', project_key: 'client-app' }),
    ) as unknown as ReturnType<typeof vi.fn> & FetchLike

    const api = new VelvetApi(baseConfig, fetchMock)
    // The repository root is a real git checkout, so the remote is read the
    // same way it would be in any other project.
    const resolver = new WorkspaceResolver(api, process.cwd(), '')

    const resolved = await resolver.resolve()
    expect(resolved).toEqual({ workspace: 'client', project: 'client-app', explicit: false })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worklog.example.com/api/v1/me/resolve-repo')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body)).remote).toContain('velvet-otter-lab')
  })

  // A configured workspace is an explicit instruction and must not be second
  // guessed by looking at the checkout.
  it('prefers an explicitly configured workspace without touching the network', async () => {
    const fetchMock = vi.fn() as unknown as ReturnType<typeof vi.fn> & FetchLike
    const api = new VelvetApi({ ...baseConfig, workspace: 'personal' }, fetchMock)
    const resolver = new WorkspaceResolver(api, process.cwd(), 'personal')

    expect(await resolver.resolve()).toEqual({ workspace: 'personal', explicit: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the remote only once for the life of the process', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ workspace_slug: 'lab' })) as unknown as ReturnType<
      typeof vi.fn
    > &
      FetchLike

    const resolver = new WorkspaceResolver(new VelvetApi(baseConfig, fetchMock), process.cwd(), '')
    await resolver.resolve()
    await resolver.resolve()
    await resolver.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // A repository can be connected in Velvet after the agent has started, so a
  // failed lookup must not poison the process.
  it('retries after a failed resolution', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'nope' } }, 404))
      .mockResolvedValueOnce(
        jsonResponse({ workspace_slug: 'lab' }),
      ) as unknown as ReturnType<typeof vi.fn> & FetchLike

    const resolver = new WorkspaceResolver(new VelvetApi(baseConfig, fetchMock), process.cwd(), '')

    await expect(resolver.resolve()).rejects.toThrow(/no connected repository matches/)
    expect(await resolver.resolve()).toEqual({ workspace: 'lab', explicit: false })
  })

  // Guessing would send work-log entries into the wrong client's record, so an
  // unreadable checkout has to say so and name the way out.
  it('explains how to proceed when the checkout has no remote', async () => {
    const fetchMock = vi.fn() as unknown as ReturnType<typeof vi.fn> & FetchLike
    const resolver = new WorkspaceResolver(new VelvetApi(baseConfig, fetchMock), '/', '')

    await expect(resolver.resolve()).rejects.toThrow(/Set VELVET_WORKSPACE/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
