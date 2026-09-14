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
  it.each(['post', 'put', 'patch', 'del'] as const)('marks bodyless %s as JSON for browser mutation protection', async (method) => {
    const spy = stubFetch(204, undefined)
    await api[method]('/auth/logout')
    expect(spy).toHaveBeenCalledWith('/api/v1/auth/logout', expect.objectContaining({
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    }))
  })

  it('keeps GET free of mutation headers', async () => {
    const spy = stubFetch(200, {})
    await api.get('/me')
    expect(spy).toHaveBeenCalledWith('/api/v1/me', expect.objectContaining({ headers: {} }))
  })

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

    const err: unknown = await api.get('/health').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(502)
  })

  it('returns undefined for a 204 rather than parsing an empty body', async () => {
    stubFetch(204, undefined)
    await expect(api.del('/w/lab/comments/1')).resolves.toBeUndefined()
  })
})
