import { beforeEach, describe, expect, it, vi } from 'vitest'

import { VelvetApi, type FetchLike } from '../src/api.js'
import { formatTicket } from '../src/format.js'
import type { VelvetConfig } from '../src/types.js'

const config: VelvetConfig = {
  baseUrl: 'https://worklog.example.com',
  token: 'velvet_test',
  workspace: 'personal',
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('VelvetApi', () => {
  const fetchMock = vi.fn() as unknown as ReturnType<typeof vi.fn> & FetchLike

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('uses the API paths and formats mocked ticket responses compactly', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          key: 'ENG-42',
          title: 'Ship MCP server',
          status: 'in_progress',
          priority: 1,
          assignee_id: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          comments: [{ body: 'Implemented the API client.', author: { name: 'Sabari' } }],
        }),
      )

    const ticket = await new VelvetApi(config, fetchMock).getTicket('eng-42')
    const output = formatTicket(ticket, config.workspace)

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://worklog.example.com/api/v1/w/personal/issues/eng-42',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer velvet_test' }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://worklog.example.com/api/v1/w/personal/issues/eng-42/comments',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(output).toContain('ENG-42: Ship MCP server')
    expect(output).toContain('Implemented the API client.')
  })

  it('maps authentication and not-found responses to actionable messages', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'sign-in required' } }, 401))
    await expect(new VelvetApi(config, fetchMock).getIssue('ENG-42')).rejects.toThrow(
      'token invalid or revoked',
    )

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'no such issue' } }, 404))
    await expect(new VelvetApi(config, fetchMock).getIssue('ENG-99')).rejects.toThrow(
      'no such issue in workspace personal',
    )
  })

  it('adds status and mine filters using the API query names', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' } }))
      .mockResolvedValueOnce(jsonResponse({ issues: [] }))

    await new VelvetApi(config, fetchMock).listIssues({ status: 'todo', mine: true })

    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/issues?status=todo&assignee_id=user-1'), expect.anything())
  })
})
