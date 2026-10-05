import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { sql } from './fixtures'

const suffix = randomBytes(4).toString('hex')
const slug = `images-${suffix}`
const email = `images-${suffix}@example.test`
const viewerEmail = `images-viewer-${suffix}@example.test`
const session = `image-session-${suffix}`
const viewerSession = `image-viewer-${suffix}`
const caption = 'The user shared this screenshot to show the missing sign-in error.'
let milestoneID: string

interface ImageAttachment {
  id: string
  filename: string
  caption: string
  source: string
  content_url: string
  download_url: string
}

interface UploadGrant {
  upload_url: string
  upload_token: string
  expires_at: string
  max_bytes: number
}

// This spec never touches production or other specs' mutable Lab data.
test.beforeAll(() => {
  sql(`
    INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Image review', '${slug}', 'IMG');
    INSERT INTO app_user (email, name) VALUES ('${email}', 'Image owner'), ('${viewerEmail}', 'Image viewer');
    INSERT INTO membership (workspace_id, user_id, role)
      SELECT w.id, u.id, CASE WHEN u.email = '${email}' THEN 'admin'::membership_role ELSE 'viewer'::membership_role END
      FROM workspace w, app_user u WHERE w.slug = '${slug}' AND u.email IN ('${email}', '${viewerEmail}');
    INSERT INTO session (id, user_id, expires_at)
      SELECT '${createHash('sha256').update(session).digest('hex')}', id, now() + interval '2 hours' FROM app_user WHERE email = '${email}';
    INSERT INTO session (id, user_id, expires_at)
      SELECT '${createHash('sha256').update(viewerSession).digest('hex')}', id, now() + interval '2 hours' FROM app_user WHERE email = '${viewerEmail}';
    INSERT INTO project (workspace_id, key, name) SELECT id, 'portal', 'Portal' FROM workspace WHERE slug = '${slug}';
    INSERT INTO sprint (workspace_id, project_id, name, starts_on, ends_on)
      SELECT workspace_id, id, 'Image acceptance', '2026-10-01', '2026-10-31' FROM project WHERE workspace_id = (SELECT id FROM workspace WHERE slug = '${slug}');
    INSERT INTO milestone (workspace_id, sprint_id, name, position)
      SELECT workspace_id, id, 'Sign-in requirements', 'a' FROM sprint WHERE workspace_id = (SELECT id FROM workspace WHERE slug = '${slug}');
    INSERT INTO issue (workspace_id, key, number, title, position, created_by)
      SELECT w.id, 'IMG-1', 1, 'Keep the sign-in error visible', 'a', u.id FROM workspace w, app_user u WHERE w.slug = '${slug}' AND u.email = '${email}';
  `)
  milestoneID = sql(`SELECT id FROM milestone WHERE workspace_id = (SELECT id FROM workspace WHERE slug = '${slug}')`)
})

test.afterAll(() => {
  sql(`DELETE FROM workspace WHERE slug = '${slug}'; DELETE FROM app_user WHERE email IN ('${email}', '${viewerEmail}');`)
})

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'ticket_session', value: session, url: baseURL! }])
})

async function sharedScreenshot(page: Page, label: string): Promise<Buffer> {
  await page.setViewportSize({ width: 640, height: 360 })
  await page.setContent(`<html><body style="margin:0;padding:32px;font:20px system-ui;background:#f5f5f5;color:#111"><h1>Sign in</h1><p>${label}</p><label>Email <input value="user@example.test"></label><p style="color:#b91c1c">The error should stay visible here.</p></body></html>`)
  return page.screenshot()
}

async function agentToken(page: Page, baseURL: string): Promise<string> {
  const response = await page.request.post('/api/v1/me/tokens', {
    headers: { Origin: baseURL }, data: { name: `Image acceptance ${randomBytes(3).toString('hex')}` },
  })
  expect(response.status()).toBe(201)
  return (await response.json()).token as string
}

async function prepareHostedUpload(agent: APIRequestContext, args: { key?: string; milestone_id?: string; filename: string; caption: string }): Promise<UploadGrant> {
  const initialized = await agent.post(`/api/v1/w/${slug}/mcp`, {
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'image-e2e-agent', version: '1' } } },
  })
  expect(initialized.status()).toBe(200)
  const response = await agent.post(`/api/v1/w/${slug}/mcp`, {
    data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'velvet_prepare_image_upload', arguments: args } },
  })
  expect(response.status()).toBe(200)
  const { result, error } = await response.json()
  expect(error).toBeUndefined()
  expect(result.isError).not.toBe(true)
  return (result.structuredContent ?? JSON.parse(result.content.find((entry: { type: string }) => entry.type === 'text').text)) as UploadGrant
}

async function assertImageLoaded(page: Page, captionText: string) {
  const image = page.getByRole('img', { name: captionText, exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
}

type ImageApproval = 'accept' | 'decline' | 'cancel' | 'false' | 'unsupported'

async function uploadThroughStdio(env: NodeJS.ProcessEnv, path: string, options: { approval?: ImageApproval; milestoneId?: string; caption?: string } = {}): Promise<string> {
  const approval = options.approval ?? 'accept'
  const relevance = options.caption ?? 'Local agent preserved the user reference.'
  const target = options.milestoneId ? { milestone_id: options.milestoneId } : { key: 'IMG-1' }
  const targetPath = options.milestoneId ? `milestones/${options.milestoneId}` : 'issues/IMG-1'
  return new Promise((resolveResult, reject) => {
    const agent = spawn(process.execPath, [resolve('..', 'mcp', 'dist', 'index.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let finished = false
    let confirmations = 0
    const timeout = setTimeout(() => finish(new Error('Local MCP image upload timed out')), 15_000)
    function finish(error?: Error, text = '') {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      agent.stdin.end()
      agent.kill()
      if (error) reject(error)
      else resolveResult(text)
    }
    function send(message: object) { agent.stdin.write(`${JSON.stringify(message)}\n`) }
    agent.on('error', (error) => finish(error))
    agent.on('close', () => finish(new Error('Local MCP exited before returning an upload result')))
    agent.stderr.resume()
    agent.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let response
        try { response = JSON.parse(line) } catch { finish(new Error('Local MCP returned invalid JSON')); return }
        if (response.method === 'elicitation/create') {
          try {
            expect(approval).not.toBe('unsupported')
            expect(response.params.mode).toBe('form')
            expect(response.params.message).toContain(`Absolute path: ${JSON.stringify(resolve(path))}`)
            expect(response.params.message).toContain(`Workspace: ${JSON.stringify(env.VELVET_WORKSPACE)}`)
            expect(response.params.message).toContain(`Destination: ${JSON.stringify(`${env.VELVET_URL}/w/${env.VELVET_WORKSPACE}/${targetPath}`)}`)
            expect(response.params.message).toContain(`Relevance: ${JSON.stringify(relevance)}`)
            expect(response.params.requestedSchema.required).toEqual(['confirm'])
            expect(response.params.requestedSchema.properties.confirm.type).toBe('boolean')
            expect(response.params.requestedSchema.properties.confirm.default).toBeUndefined()
            confirmations += 1
            send({ jsonrpc: '2.0', id: response.id, result: approval === 'decline' || approval === 'cancel'
              ? { action: approval } : { action: 'accept', content: { confirm: approval === 'accept' } } })
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
          continue
        }
        if (response.error) { finish(new Error('Local MCP rejected the image request')); return }
        if (response.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'velvet_upload_image', arguments: { ...target, path, caption: relevance } } })
        } else if (response.id === 2) {
          const text = response.result.content.map((entry: { text?: string }) => entry.text ?? '').join('\n')
          if (response.result?.isError) finish(new Error(text))
          else if (confirmations !== 1) finish(new Error('Local MCP uploaded without exactly one user confirmation'))
          else finish(undefined, text)
        }
      }
    })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: approval === 'unsupported' ? {} : { elicitation: { form: {} } }, clientInfo: { name: 'image-acceptance', version: '1' } } })
  })
}

test('hosted agent preserves a shared image on its ticket and portal removal is explicit', async ({ page, playwright, baseURL }) => {
  const bytes = await sharedScreenshot(page, 'Ticket reference: the error disappears after submitting.')
  const token = await agentToken(page, baseURL!)
  const agent = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' } })
  const transfer = await playwright.request.newContext({ baseURL })
  try {
    const grant = await prepareHostedUpload(agent, { key: 'IMG-1', filename: 'user-sign-in-reference.png', caption })
    expect(grant.max_bytes).toBe(10 * 1024 * 1024)
    expect(Date.parse(grant.expires_at)).toBeGreaterThan(Date.now())
    const uploaded = await transfer.post(grant.upload_url, {
      headers: { 'X-Velvet-Upload-Token': grant.upload_token },
      multipart: { file: { name: 'user-sign-in-reference.png', mimeType: 'image/png', buffer: bytes } },
    })
    expect(uploaded.status()).toBe(201)
    const image = await uploaded.json() as ImageAttachment
    expect(image.caption).toBe(caption)
    expect(image.source).toBe('agent')
    expect((await transfer.get(image.content_url)).status()).toBe(401)
    const reused = await transfer.post(grant.upload_url, {
      headers: { 'X-Velvet-Upload-Token': grant.upload_token },
      multipart: { file: { name: 'user-sign-in-reference.png', mimeType: 'image/png', buffer: bytes } },
    })
    expect(reused.status()).toBeGreaterThanOrEqual(400)
    const listed = await agent.get(`/api/v1/w/${slug}/issues/IMG-1/images`)
    expect((await listed.json()).images.filter((candidate: ImageAttachment) => candidate.id === image.id)).toHaveLength(1)
    const issue = await agent.get(`/api/v1/w/${slug}/issues/IMG-1`)
    expect((await issue.json()).status).toBe('backlog')

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/w/${slug}/issues/IMG-1`)
    await expect(page.getByRole('heading', { level: 2, name: 'Images', exact: true })).toBeVisible()
    await assertImageLoaded(page, caption)
    await page.reload()
    await assertImageLoaded(page, caption)
    const protectedBytes = await page.request.get(image.content_url)
    expect(protectedBytes.status()).toBe(200)
    expect(protectedBytes.headers()['cache-control']).toContain('no-store')
    expect(protectedBytes.headers()['content-type']).toContain('image/png')
    const storedBytes = await protectedBytes.body()
    expect(storedBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const bitmap = await page.getByRole('img', { name: caption, exact: true }).evaluate((element: HTMLImageElement) => ({ width: element.naturalWidth, height: element.naturalHeight }))
    expect(bitmap).toEqual({ width: 640, height: 360 })
    // Sanitisation may rewrite container metadata, so assert visual dimensions,
    // a real loaded bitmap and stable served bytes rather than original encoding.
    expect(createHash('sha256').update(await (await page.request.get(image.content_url)).body()).digest('hex')).toBe(createHash('sha256').update(storedBytes).digest('hex'))
    const download = await page.request.get(image.download_url)
    expect(download.status()).toBe(200)
    expect(download.headers()['content-disposition']).toContain('attachment')

    for (const width of [1280, 390, 1720]) {
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : width === 1720 ? 1000 : 900 })
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
        await assertImageLoaded(page, caption)
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
        await page.screenshot({ path: `test-results/images-ticket-${width}-${colorScheme}.png`, fullPage: true })
      }
    }
    const row = page.getByTestId(`image-item-${image.id}`)
    const originalLink = row.getByRole('link', { name: /open full image/i }).last()
    await row.getByRole('link', { name: /open full image/i }).first().focus()
    await page.keyboard.press('Tab')
    await expect(originalLink).toBeFocused()
    expect(await originalLink.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
    const popupPromise = page.waitForEvent('popup')
    await originalLink.click()
    const fullImage = await popupPromise
    await expect.poll(() => fullImage.locator('img').evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth === 640)).toBe(true)
    await fullImage.close()
    const downloadPromise = page.waitForEvent('download')
    await row.getByRole('link', { name: /^Download/ }).click()
    expect((await downloadPromise).suggestedFilename()).toBe(image.filename)
    await row.getByRole('button', { name: /delete image:/i }).click()
    await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await row.getByRole('button', { name: /cancel/i }).click()
    await assertImageLoaded(page, caption)
    await row.getByRole('button', { name: /delete image:/i }).click()
    await row.getByRole('button', { name: 'Delete image', exact: true }).click()
    await expect(row).toHaveCount(0)
    expect((await page.request.get(image.content_url)).status()).toBe(404)
  } finally {
    await transfer.dispose()
    await agent.dispose()
  }
})

test('CLI uploads to a milestone, with readable responsive previews and read-only viewers', async ({ page, playwright, baseURL }) => {
  const bytes = await sharedScreenshot(page, 'Milestone reference: accepted sign-in design.')
  const token = await agentToken(page, baseURL!)
  const filename = resolve('test-results', `${'long-user-reference-'.repeat(8)}${suffix}.png`)
  await mkdir(resolve('test-results'), { recursive: true })
  await writeFile(filename, bytes)
  const cli = resolve('..', 'cli', 'velvet')
  const result = await promisify(execFile)(cli, ['upload-image', '--milestone', milestoneID, filename, '--caption', caption], {
    env: { ...process.env, VELVET_URL: baseURL!, VELVET_WORKSPACE: slug, VELVET_TOKEN: token },
  })
  expect(result.stdout).toContain(milestoneID)
  const listed = await page.request.get(`/api/v1/w/${slug}/milestones/${milestoneID}/images`)
  const images = (await listed.json()).images as ImageAttachment[]
  const image = images.find((candidate) => candidate.caption === caption)!
  expect(image).toBeDefined()
  expect(image.source).toBe('agent')

  for (const width of [1280, 390, 1720]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : width === 1720 ? 1000 : 900 })
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.goto(`/w/${slug}/milestones/${milestoneID}`)
      await assertImageLoaded(page, caption)
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
      await page.screenshot({ path: `test-results/images-milestone-${width}-${colorScheme}.png`, fullPage: true })
    }
  }
  const viewer = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Cookie: `ticket_session=${viewerSession}`, Origin: baseURL! } })
  try {
    expect((await viewer.get(image.content_url)).status()).toBe(200)
    expect((await viewer.delete(`/api/v1/w/${slug}/images/${image.id}`, { data: {} })).status()).toBe(403)
    await page.context().clearCookies()
    await page.context().addCookies([{ name: 'ticket_session', value: viewerSession, url: baseURL! }])
    await page.goto(`/w/${slug}/milestones/${milestoneID}`)
    await assertImageLoaded(page, caption)
    await expect(page.getByTestId(`image-item-${image.id}`).getByRole('button', { name: /delete image:/i })).toHaveCount(0)
    expect((await page.request.get(`/api/v1/w/not-${slug}/images/${image.id}/content`)).status()).toBe(404)
  } finally {
    await viewer.dispose()
  }
})

test('local stdio MCP preserves a real file on the ticket, not image bytes in its tool output', async ({ page, baseURL }) => {
  const bytes = await sharedScreenshot(page, 'Local stdio agent reference.')
  const token = await agentToken(page, baseURL!)
  const path = resolve('test-results', `stdio-reference-${suffix}.png`)
  await mkdir(resolve('test-results'), { recursive: true })
  await writeFile(path, bytes)
  const text = await uploadThroughStdio({ ...process.env, VELVET_URL: baseURL!, VELVET_WORKSPACE: slug, VELVET_TOKEN: token }, path)
  expect(text).toContain('Status unchanged')
  expect(text).toContain(`/w/${slug}/issues/IMG-1`)
  expect(text).not.toContain(bytes.toString('base64'))
  await page.goto(`/w/${slug}/issues/IMG-1`)
  await assertImageLoaded(page, 'Local agent preserved the user reference.')
  await page.reload()
  await assertImageLoaded(page, 'Local agent preserved the user reference.')
  const milestoneCaption = 'User-approved local image for the milestone.'
  const milestoneText = await uploadThroughStdio({ ...process.env, VELVET_URL: baseURL!, VELVET_WORKSPACE: slug, VELVET_TOKEN: token }, path,
    { milestoneId: milestoneID, caption: milestoneCaption })
  expect(milestoneText).toContain(`/w/${slug}/milestones/${milestoneID}`)
  await page.goto(`/w/${slug}/milestones/${milestoneID}`)
  await assertImageLoaded(page, milestoneCaption)
})

test('local stdio MCP requires exact-file consent and rejects non-images before upload', async ({ page, baseURL }) => {
  const bytes = await sharedScreenshot(page, 'Image upload consent reference.')
  const token = await agentToken(page, baseURL!)
  const path = resolve('test-results', `consent-reference-${suffix}.png`)
  await mkdir(resolve('test-results'), { recursive: true })
  await writeFile(path, bytes)
  const env = { ...process.env, VELVET_URL: baseURL!, VELVET_WORKSPACE: slug, VELVET_TOKEN: token }
  const before = (await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1/images`)).json()).images.length
  for (const approval of ['decline', 'cancel', 'false', 'unsupported'] as const) {
    await expect(uploadThroughStdio(env, path, { approval })).rejects.toThrow(
      approval === 'unsupported' ? /form elicitation support/ : /not confirmed/,
    )
    expect((await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1/images`)).json()).images).toHaveLength(before)
  }
  const nonImage = resolve('test-results', `not-an-image-${suffix}.png`)
  await writeFile(nonImage, 'SYNTHETIC_NON_IMAGE_CONTENT_NOT_A_REAL_SECRET')
  await expect(uploadThroughStdio(env, nonImage)).rejects.toThrow(/PNG|JPEG|WebP/)
  expect((await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1/images`)).json()).images).toHaveLength(before)
  expect((await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1`)).json()).status).toBe('backlog')
})

test('JPEG and WebP agent references can be viewed, downloaded and explicitly removed on mobile', async ({ page, baseURL }) => {
  const reference = await sharedScreenshot(page, 'User reference: preserve the visible sign-in error.')
  const token = await agentToken(page, baseURL!)
  await mkdir(resolve('test-results'), { recursive: true })
  for (const format of ['jpeg', 'webp'] as const) {
    // Use the browser's real encoder on the same user-reference bitmap rather
    // than a magic header fixture that merely pretends to be another format.
    const encoded = await page.evaluate(async ({ bytes, format }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
      bitmap.close()
      const blob = await new Promise<Blob>((done) => canvas.toBlob((blob) => done(blob!), `image/${format}`, 0.95))
      if (blob.type !== `image/${format}`) throw new Error('Browser did not encode the requested image format')
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }, { bytes: Array.from(reference), format })
    const filename = `user-reference-${suffix}.${format}`
    const path = resolve('test-results', filename)
    const relevance = `The user shared this ${format.toUpperCase()} reference to show the required sign-in error.`
    await writeFile(path, Buffer.from(encoded))
    const uploaded = await promisify(execFile)(resolve('..', 'cli', 'velvet'), ['upload-image', 'IMG-1', path, '--caption', relevance], {
      env: { ...process.env, VELVET_URL: baseURL!, VELVET_WORKSPACE: slug, VELVET_TOKEN: token },
    })
    expect(uploaded.stdout).toContain('Status unchanged')
    const listed = await page.request.get(`/api/v1/w/${slug}/issues/IMG-1/images`)
    const image = ((await listed.json()).images as ImageAttachment[]).find((candidate) => candidate.caption === relevance)!
    expect(image).toBeDefined()
    expect(image.source).toBe('agent')
    const content = await page.request.get(image.content_url)
    expect(content.status()).toBe(200)
    expect(content.headers()['content-type']).toBe(`image/${format}`)
    expect(content.headers()['cache-control']).toBe('no-store')
    const originalPixelsPreserved = await page.evaluate(async (images) => {
      const pixels = []
      for (const bytes of images) {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]))
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        bitmap.close()
        pixels.push(context.getImageData(0, 0, canvas.width, canvas.height).data)
      }
      return pixels[0].length === pixels[1].length && pixels[0].every((value, index) => value === pixels[1][index])
    }, [encoded, Array.from(await content.body())])
    expect(originalPixelsPreserved).toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/w/${slug}/issues/IMG-1`)
    await page.reload()
    const row = page.getByTestId(`image-item-${image.id}`)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await assertImageLoaded(page, relevance)
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
      const popupPromise = page.waitForEvent('popup')
      await row.getByRole('link', { name: /open full image/i }).last().click()
      const fullImage = await popupPromise
      await expect.poll(() => fullImage.locator('img').evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth === 640 && element.naturalHeight === 360)).toBe(true)
      await fullImage.close()
      const downloadPromise = page.waitForEvent('download')
      await row.getByRole('link', { name: /^Download/ }).click()
      expect((await downloadPromise).suggestedFilename()).toBe(filename)
    }
    await row.getByRole('button', { name: /delete image:/i }).click()
    await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    await assertImageLoaded(page, relevance)
    await row.getByRole('button', { name: /delete image:/i }).click()
    await row.getByRole('button', { name: 'Delete image', exact: true }).click()
    await expect(row).toHaveCount(0)
    expect((await page.request.get(image.content_url)).status()).toBe(404)
    const approvedCaption = `User-approved ${format.toUpperCase()} local MCP reference.`
    const approved = await uploadThroughStdio({ ...process.env, VELVET_URL: baseURL!, VELVET_WORKSPACE: slug, VELVET_TOKEN: token }, path,
      { caption: approvedCaption })
    expect(approved).toContain('Status unchanged')
    await page.reload()
    await assertImageLoaded(page, approvedCaption)
    expect((await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1`)).json()).status).toBe('backlog')
  }
})
