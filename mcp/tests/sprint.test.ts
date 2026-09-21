import { describe, expect, it, vi } from 'vitest'

import { VelvetApi, type FetchLike } from '../src/api.js'
import {
  formatCreatedMilestone,
  formatCreatedSprint,
  formatSprints,
} from '../src/format.js'
import type { VelvetConfig } from '../src/types.js'

/**
 * The sprint loop a manager's instruction creates. These lock the request
 * shapes and the rendered output; the live stdio rehearsal covers the server
 * end to end.
 */

const config: VelvetConfig = {
  baseUrl: 'https://worklog.example.com',
  token: 'velvet_test',
  workspace: 'lab',
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const sprint = {
  id: 's-1',
  name: 'September 2026',
  starts_on: '2026-09-01',
  ends_on: '2026-09-30',
  state: 'upcoming' as const,
}

describe('sprint scheduling', () => {
  it('creates a sprint at the workspace-scoped path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(sprint)) as unknown as ReturnType<typeof vi.fn> & FetchLike

    const created = await new VelvetApi(config, fetchMock).createSprint({
      name: 'September 2026',
      starts_on: '2026-09-01',
      ends_on: '2026-09-30',
    })
    expect(created.id).toBe('s-1')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worklog.example.com/api/v1/w/lab/sprints')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'September 2026',
      starts_on: '2026-09-01',
      ends_on: '2026-09-30',
    })
  })

  it('creates a milestone under the sprint that owns it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ id: 'm-1', name: 'Ship it' }),
      ) as unknown as ReturnType<typeof vi.fn> & FetchLike

    await new VelvetApi(config, fetchMock).createMilestone('s-1', { name: 'Ship it' })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worklog.example.com/api/v1/w/lab/sprints/s-1/milestones')
  })

  // An empty string must reach the API as a JSON null, because that is what
  // clears the reference. Dropping the field would silently leave the ticket
  // scheduled.
  it('sends null to unschedule a ticket', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ key: 'ENG-1', title: 'Ship it' }),
      ) as unknown as ReturnType<typeof vi.fn> & FetchLike

    await new VelvetApi(config, fetchMock).updateIssue('ENG-1', { milestone_id: null })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worklog.example.com/api/v1/w/lab/issues/ENG-1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ milestone_id: null })
  })

  it('tolerates a bare array and a missing key when listing sprints', async () => {
    for (const body of [{ sprints: [sprint] }, [sprint]]) {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(body)) as unknown as ReturnType<typeof vi.fn> & FetchLike
      expect(await new VelvetApi(config, fetchMock).listSprints()).toHaveLength(1)
    }

    const empty = vi
      .fn()
      .mockResolvedValue(jsonResponse({})) as unknown as ReturnType<typeof vi.fn> & FetchLike
    expect(await new VelvetApi(config, empty).listSprints()).toEqual([])
  })

  it('renders sprints, and says so when there are none', () => {
    expect(formatSprints([], 'lab')).toBe('No sprints found in workspace lab.')

    const rendered = formatSprints([sprint], 'lab')
    expect(rendered).toContain('September 2026')
    expect(rendered).toContain('upcoming')
    expect(rendered).toContain('2026-09-01 to 2026-09-30')
    // The id is what velvet_create_milestone needs next, so it must be shown.
    expect(rendered).toContain('s-1')
  })

  // Activating a sprint completes whichever one was active, so the reply must
  // not imply the new sprint is already running.
  it('reports a new sprint as upcoming rather than active', () => {
    const rendered = formatCreatedSprint(sprint)
    expect(rendered).toContain('upcoming')
    expect(rendered).toContain('Activate it when work starts.')
    expect(rendered).toContain('s-1')
  })

  it('tells the caller how to file work under a new milestone', () => {
    const rendered = formatCreatedMilestone({ id: 'm-1', name: 'Ship it' })
    expect(rendered).toContain('m-1')
    expect(rendered).toContain('milestone_id')
  })
})
