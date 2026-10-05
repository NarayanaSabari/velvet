import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema, type ClientCapabilities, type ElicitRequestFormParams, type ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { mkdtemp, writeFile, rm, open, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createMcpServer } from '../src/tools.js'
import { VelvetApi } from '../src/api.js'
import * as images from '../src/images.js'
import { pngBytes } from './image-fixtures.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) }
})

const dirs: string[] = []
const connections: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(connections.splice(0).map(async ({ client, server }) => { await client.close(); await server.close() }))
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const formCapabilities: ClientCapabilities = { elicitation: { form: {} } }
const accepted: ElicitResult = { action: 'accept', content: { confirm: true } }
const args = { caption: 'Shows the bug', key: 'eng-1' }

async function setup(options: {
  capabilities?: ClientCapabilities
  response?: ElicitResult
  handler?: (params: ElicitRequestFormParams) => ElicitResult | Promise<ElicitResult>
  workspace?: string
  cwd?: string
  noHandler?: boolean
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'velvet-image-tools-'))
  dirs.push(dir)
  const path = join(dir, 'shot.png')
  await writeFile(path, pngBytes)
  const http = { status: 201 }
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture')
    if (init?.method === 'GET') return Response.json({ images: [{ id: 'img' }] })
    if (String(url).endsWith('/me/resolve-repo')) return Response.json({ workspace_slug: 'lab' })
    expect(init?.redirect).toBe('error')
    const form = init?.body as FormData
    expect(form.get('caption')).toBe('Shows the bug')
    const file = form.get('file') as File
    expect(file.type).toBe('image/png')
    expect(Buffer.from(await file.arrayBuffer())).toEqual(pngBytes)
    return Response.json({ id: 'img', filename: file.name, content_url: '/content', error: { message: 'denied' } }, { status: http.status })
  })
  const server = createMcpServer({ baseUrl: 'https://velvet.example', token: 'fixture', workspace: options.workspace ?? 'lab' }, { fetchImpl, cwd: options.cwd ?? dir })
  const capabilities = options.capabilities ?? formCapabilities
  const client = new Client({ name: 'image-test', version: '1' }, { capabilities })
  const elicited = vi.fn((params: ElicitRequestFormParams) => options.handler ? options.handler(params) : options.response ?? accepted)
  if (!options.noHandler && capabilities.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, request => {
      if (request.params.mode === 'url') throw new Error('Unexpected URL elicitation')
      return elicited(request.params)
    })
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  connections.push({ client, server })
  return { path, dir, client, server, fetchImpl, elicited, http }
}

function expectNoFileOrNetwork(harness: Awaited<ReturnType<typeof setup>>) {
  expect(open).not.toHaveBeenCalled()
  expect(lstat).not.toHaveBeenCalled()
  expect(harness.fetchImpl).not.toHaveBeenCalled()
}

it('uses real SDK form consent for every issue/milestone upload, with no affirmative defaults', async () => {
  const h = await setup()
  expect((await h.client.listTools()).tools.map(tool => tool.name)).toContain('velvet_upload_image')
  for (const target of [{}, { key: 'ENG-1', milestone_id: 'id' }]) {
    expect((await h.client.callTool({ name: 'velvet_upload_image', arguments: { path: h.path, caption: args.caption, ...target } })).isError).toBe(true)
  }
  expect(h.elicited).not.toHaveBeenCalled()
  expectNoFileOrNetwork(h)
  const result = await h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: 'shot.png', confirm: true } })
  expect(result.isError).not.toBe(true)
  expect(JSON.stringify(result.content)).toContain('/w/lab/issues/ENG-1')
  expect(h.elicited).toHaveBeenCalledExactlyOnceWith({
    mode: 'form',
    message: `Allow reading and uploading this local image?\nAbsolute path: ${JSON.stringify(resolve(h.dir, 'shot.png'))}\nWorkspace: "lab"\nDestination: "https://velvet.example/w/lab/issues/ENG-1"\nRelevance: "Shows the bug"\nOnly this file will be sent. Status will not change.`,
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', title: 'Allow reading and uploading this exact file to this destination?' } },
      required: ['confirm'],
    },
  })
  h.http.status = 403
  const denied = await h.client.callTool({ name: 'velvet_upload_image', arguments: { path: h.path, caption: args.caption, milestone_id: 'm/1' } })
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('HTTP 403')
  expect(h.elicited).toHaveBeenCalledTimes(2)
  expect(h.elicited.mock.calls[1][0].message).toContain('https://velvet.example/w/lab/milestones/m%2F1')
  expect(h.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
    'https://velvet.example/api/v1/w/lab/issues/ENG-1/images',
    'https://velvet.example/api/v1/w/lab/milestones/m%2F1/images',
  ])
})

it.each([
  ['decline', { action: 'decline' }],
  ['cancel', { action: 'cancel' }],
  ['missing content', { action: 'accept' }],
  ['false', { action: 'accept', content: { confirm: false } }],
  ['missing confirm', { action: 'accept', content: {} }],
  ['string true', { action: 'accept', content: { confirm: 'true' } }],
  ['numeric true', { action: 'accept', content: { confirm: 1 } }],
])('blocks %s before any file operation or network call despite a model approval argument', async (_name, response) => {
  const h = await setup({ response: response as ElicitResult })
  const result = await h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path, confirm: true } })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('run velvet upload-image manually')
  expect(h.elicited).toHaveBeenCalledTimes(1)
  expectNoFileOrNetwork(h)
})

it.each([
  ['absent', {}],
  ['URL-only', { elicitation: { url: {} } }],
])('blocks %s capability without touching files, discovery, or HTTP', async (_name, capabilities) => {
  const h = await setup({ capabilities, workspace: '' })
  const result = await h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('requires a client with form elicitation support')
  expect(h.elicited).not.toHaveBeenCalled()
  expectNoFileOrNetwork(h)
})

it('supports legacy empty elicitation capability through SDK negotiation', async () => {
  const h = await setup({ capabilities: { elicitation: {} } })
  expect(h.server.server.getClientCapabilities()?.elicitation?.form).toEqual({})
  expect((await h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } })).isError).not.toBe(true)
  expect(h.elicited).toHaveBeenCalledTimes(1)
})

it('requires an established destination before confirmation or upload discovery', async () => {
  const h = await setup({ workspace: '' })
  const result = await h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('velvet_where_am_i first')
  expect(h.elicited).not.toHaveBeenCalled()
  expectNoFileOrNetwork(h)
})

it('keeps read-only tools compatible without elicitation', async () => {
  const h = await setup({ capabilities: {} })
  expect((await h.client.callTool({ name: 'velvet_where_am_i', arguments: {} })).isError).not.toBe(true)
  expect((await h.client.callTool({ name: 'velvet_list_images', arguments: { milestone_id: 'm-1' } })).isError).not.toBe(true)
  expect(h.elicited).not.toHaveBeenCalled()
  expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  expect(h.fetchImpl.mock.calls[0][1]?.method).toBe('GET')
  expect(open).not.toHaveBeenCalled()
})

it('uses a destination discovered by an earlier where_am_i without rediscovery during upload', async () => {
  const h = await setup({ workspace: '', cwd: process.cwd() })
  const discovered = await h.client.callTool({ name: 'velvet_where_am_i', arguments: {} })
  expect(discovered.isError).not.toBe(true)
  expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  expect(String(h.fetchImpl.mock.calls[0][0])).toBe('https://velvet.example/api/v1/me/resolve-repo')
  h.fetchImpl.mockClear()
  expectNoFileOrNetwork(h)
  const uploaded = await h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } })
  expect(uploaded.isError).not.toBe(true)
  expect(h.elicited.mock.calls[0][0].message).toContain('Workspace: "lab"')
  expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  expect(String(h.fetchImpl.mock.calls[0][0])).toBe('https://velvet.example/api/v1/w/lab/issues/ENG-1/images')
})

it('refuses a changed namespace after accepted confirmation before opening the file', async () => {
  const h = await setup()
  vi.spyOn(VelvetApi.prototype, 'currentWorkspace', 'get').mockReturnValueOnce('lab').mockReturnValueOnce('other')
  const result = await h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('destination changed during confirmation')
  expect(h.elicited).toHaveBeenCalledTimes(1)
  expectNoFileOrNetwork(h)
})

it.each(['missing handler', 'handler error'])('fails closed on %s', async name => {
  const h = await setup({ noHandler: name === 'missing handler', handler: () => { throw new Error('confirmation unavailable') } })
  const result = await h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('run velvet upload-image manually')
  expectNoFileOrNetwork(h)
})

it('does not open the file or send HTTP while consent is pending', async () => {
  let respond!: (result: ElicitResult) => void
  const h = await setup({ handler: () => new Promise(resolveResult => { respond = resolveResult }) })
  const pending = h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } })
  await vi.waitFor(() => expect(h.elicited).toHaveBeenCalledTimes(1))
  expectNoFileOrNetwork(h)
  respond(accepted)
  expect((await pending).isError).not.toBe(true)
  expect(open).toHaveBeenCalledTimes(1)
  expect(h.fetchImpl).toHaveBeenCalledTimes(1)
})

it('fails closed when the tool call is cancelled while elicitation is pending', async () => {
  let respond!: (result: ElicitResult) => void
  const h = await setup({ handler: () => new Promise(resolveResult => { respond = resolveResult }) })
  const controller = new AbortController()
  const pending = h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } }, undefined, { signal: controller.signal }).catch(error => error)
  await vi.waitFor(() => expect(h.elicited).toHaveBeenCalledTimes(1))
  controller.abort()
  expect(await pending).toBeInstanceOf(Error)
  respond(accepted)
  await new Promise(resolveResult => setImmediate(resolveResult))
  expectNoFileOrNetwork(h)
})

it('fails closed when elicitation times out', async () => {
  const h = await setup({ handler: () => new Promise(() => {}) })
  vi.useFakeTimers()
  const pending = h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } }, undefined, { timeout: 120_000 })
  await vi.advanceTimersByTimeAsync(60_001)
  expect((await pending).isError).toBe(true)
  expectNoFileOrNetwork(h)
})

it('stops further file reads and closes the handle without POST when cancelled during preflight', async () => {
  const h = await setup()
  const { open: originalOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let releaseRead!: () => void
  const pausedRead = new Promise<void>(resolveRead => { releaseRead = resolveRead })
  let read: ReturnType<typeof vi.spyOn>
  let close: ReturnType<typeof vi.spyOn>
  vi.mocked(open).mockImplementationOnce(async (...parameters) => {
    const handle = await originalOpen(...parameters)
    const originalRead = handle.read.bind(handle)
    read = vi.spyOn(handle, 'read').mockImplementationOnce(async (...parameters: unknown[]) => {
      await pausedRead
      // Return a partial read so an uncancelled preflight would read again.
      const [buffer, offset, length, position] = parameters as [Buffer, number, number, number | null]
      return originalRead(buffer, offset, Math.min(length, 4), position)
    })
    close = vi.spyOn(handle, 'close')
    return handle
  })
  const preflight = vi.spyOn(images, 'imageForm')
  const controller = new AbortController()
  const pending = h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } }, undefined, { signal: controller.signal }).catch(error => error)
  await vi.waitFor(() => expect(read!).toHaveBeenCalledTimes(1))
  const signal = preflight.mock.calls[0][2]!
  expect(signal).toBeInstanceOf(AbortSignal)
  controller.abort()
  expect(await pending).toBeInstanceOf(Error)
  await vi.waitFor(() => expect(signal.aborted).toBe(true))
  releaseRead()
  await vi.waitFor(() => expect(close!).toHaveBeenCalledTimes(1))
  expect(read!).toHaveBeenCalledTimes(1)
  expect(h.fetchImpl).not.toHaveBeenCalled()
})

it('passes the tool signal to a pending upload fetch and observes in-flight abort without retrying', async () => {
  const h = await setup()
  const abortObserved = vi.fn()
  let signal: AbortSignal
  h.fetchImpl.mockImplementationOnce(async (_url, init) => {
    signal = init!.signal!
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        abortObserved()
        reject(signal.reason)
      }, { once: true })
    })
  })
  const controller = new AbortController()
  const pending = h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } }, undefined, { signal: controller.signal }).catch(error => error)
  await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(1))
  expect(h.fetchImpl.mock.calls[0][1]?.method).toBe('POST')
  controller.abort()
  expect(await pending).toBeInstanceOf(Error)
  await vi.waitFor(() => expect(abortObserved).toHaveBeenCalledTimes(1))
  expect(signal!.aborted).toBe(true)
  expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledTimes(1)
})

it('rejects an approved ordinary nonimage before multipart transport', async () => {
  const h = await setup()
  await writeFile(h.path, 'synthetic secret text, never a real secret')
  const result = await h.client.callTool({ name: 'velvet_upload_image', arguments: { ...args, path: h.path } })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('PNG, JPEG, or WebP signature')
  expect(h.elicited).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledTimes(1)
  expect(h.fetchImpl).not.toHaveBeenCalled()
})
