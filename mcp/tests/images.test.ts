import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, symlink, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageForm, imageTarget, MAX_IMAGE_BYTES } from '../src/images.js'
import { VelvetApi } from '../src/api.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'velvet-images-'))
  dirs.push(dir)
  const path = join(dir, 'shot.png')
  await writeFile(path, 'image bytes')
  return { dir, path }
}
describe('explicit local images', () => {
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
      expect(await file.text()).toBe('image bytes')
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
  it.each([401, 403, 404, 413, 415])('surfaces HTTP %s upload failures', async status => {
    const api = new VelvetApi({ baseUrl: 'https://velvet.example', token: 'test', workspace: 'org' }, async () => Response.json({ error: { message: 'rejected' } }, { status }))
    await expect(api.uploadImage('issues/ENG-1', new FormData())).rejects.toMatchObject({ status })
  })
})
