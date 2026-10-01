import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpServer } from '../src/tools.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('calls local image tools via SDK, validates targets and preserves authorization errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'velvet-image-tools-'))
  dirs.push(dir)
  const path = join(dir, 'shot.png')
  await writeFile(path, 'fixture bytes')
  const calls: string[] = []
  let status = 201
  const server = createMcpServer({ baseUrl: 'https://velvet.example', token: 'fixture', workspace: 'lab' }, {
    fetchImpl: async (url, init) => {
      calls.push(String(url))
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture')
      if (init?.method === 'GET') return Response.json({ images: [{ id: 'img' }] })
      const form = init?.body as FormData
      expect(form.get('caption')).toBe('Shows the bug')
      expect(await (form.get('file') as File).text()).toBe('fixture bytes')
      return Response.json({ id: 'img', filename: 'shot.png', content_url: '/content', error: { message: 'denied' } }, { status })
    },
  })
  const client = new Client({ name: 'image-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toContain('velvet_upload_image')
    for (const args of [{}, { key: 'ENG-1', milestone_id: 'id' }]) {
      const result = await client.callTool({ name: 'velvet_upload_image', arguments: { path, caption: 'Shows the bug', ...args } })
      expect(result.isError).toBe(true)
    }
    expect(calls).toEqual([])
    const uploaded = await client.callTool({ name: 'velvet_upload_image', arguments: { path, caption: 'Shows the bug', key: 'eng-1' } })
    expect(uploaded.isError).not.toBe(true)
    expect(JSON.stringify(uploaded.content)).toContain('/w/lab/issues/ENG-1')
    expect(calls).toEqual(['https://velvet.example/api/v1/w/lab/issues/ENG-1/images'])
    status = 403
    const rejected = await client.callTool({ name: 'velvet_upload_image', arguments: { path, caption: 'Shows the bug', milestone_id: 'm-1' } })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain('HTTP 403')
    const images = await client.callTool({ name: 'velvet_list_images', arguments: { milestone_id: 'm-1' } })
    expect(images.isError).not.toBe(true)
    expect(JSON.stringify(images.content)).toContain('img')
  } finally {
    await client.close()
    await server.close()
  }
})
