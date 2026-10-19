import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, symlink, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageForm, imageTarget, MAX_IMAGE_BYTES } from '../src/images.js'
import { VelvetApi } from '../src/api.js'
import { pngBytes } from './image-fixtures.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'velvet-images-'))
  dirs.push(dir)
  const path = join(dir, 'shot.png')
  await writeFile(path, pngBytes)
  return { dir, path }
}
describe('explicit local images', () => {
  it('rejects an already cancelled preflight before accessing even a missing path', async () => {
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    await expect(imageForm('/missing/local/image.png', 'why', controller.signal)).rejects.toThrow('user cancelled')
  })
  it('requires exactly one explicit target and encodes it', () => {
    expect(() => imageTarget()).toThrow('exactly one')
    expect(() => imageTarget('ENG-1', 'id')).toThrow('exactly one')
    expect(imageTarget('eng-1')).toBe('issues/ENG-1')
    expect(imageTarget(undefined, 'a/b')).toBe('milestones/a%2Fb')
  })
  it('uploads native multipart file and caption with scoped bearer auth', async () => {
    const { path } = await fixture()
    const form = await imageForm(path, ' relevant screenshot ')
    const api = new VelvetApi({ baseUrl: 'https://velvet.example', token: 'test-token', workspace: 'my org' }, async (url, init) => {
      expect(url).toBe('https://velvet.example/api/v1/w/my%20org/milestones/id/images')
      expect(init?.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer test-token' })
      expect(init?.body).toBe(form)
      expect(form.get('caption')).toBe('relevant screenshot')
      const file = form.get('file') as File
      expect(file.name).toBe('shot.png')
      expect(Buffer.from(await file.arrayBuffer())).toEqual(pngBytes)
      expect(file.type).toBe('image/png')
      expect(init?.redirect).toBe('error')
      return Response.json({ id: 'image-id', filename: file.name, content_url: '/content' }, { status: 201 })
    })
    expect((await api.uploadImage(imageTarget(undefined, 'id'), form)).id).toBe('image-id')
  })
  it('rejects symlinks, directories, missing/empty/oversize files and blank caption', async () => {
    const { dir, path } = await fixture()
    await symlink(path, join(dir, 'link'))
    await expect(imageForm(join(dir, 'link'), 'why')).rejects.toThrow('regular file')
    await expect(imageForm(dir, 'why')).rejects.toThrow('regular file')
    await expect(imageForm(join(dir, 'missing'), 'why')).rejects.toThrow()
    await expect(imageForm(path, ' ')).rejects.toThrow('caption')
    await truncate(path, 0)
    await expect(imageForm(path, 'why')).rejects.toThrow('empty')
    await truncate(path, MAX_IMAGE_BYTES + 1)
    await expect(imageForm(path, 'why')).rejects.toThrow('10 MiB')
  })
  it.each([
    ['image/png', pngBytes],
    ['image/jpeg', Buffer.from([255, 216, 255, 224])],
    ['image/webp', Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary')],
  ])('detects %s signatures without relying on a file extension', async (type, bytes) => {
    const { dir } = await fixture()
    const path = join(dir, 'user-reference')
    await writeFile(path, bytes)
    const file = (await imageForm(path, 'why')).get('file') as File
    expect(file.type).toBe(type)
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes)
  })
  it.each([
    Buffer.from('synthetic secret, not an image'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('GIF89a'),
    pngBytes.subarray(0, 7),
    Buffer.from([255, 216]),
    Buffer.from('RIFF\x04\x00\x00\x00WEB', 'binary'),
    Buffer.from('RIFF\x04\x00\x00\x00WAVE', 'binary'),
    Buffer.from([210, 201, 198, 198, 4, 0, 0, 0, 215, 197, 194, 208]),
  ])('rejects unsupported and truncated bytes even with a PNG filename', async bytes => {
    const { path } = await fixture()
    await writeFile(path, bytes)
    await expect(imageForm(path, 'why')).rejects.toThrow('signature')
  })
  it.each([401, 403, 404, 413, 415])('surfaces HTTP %s upload failures', async status => {
    const api = new VelvetApi({ baseUrl: 'https://velvet.example', token: 'test', workspace: 'org' }, async () => Response.json({ error: { message: 'rejected' } }, { status }))
    await expect(api.uploadImage('issues/ENG-1', new FormData())).rejects.toMatchObject({ status })
  })
})
