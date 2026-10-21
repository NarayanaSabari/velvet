import { test, expect, type Page } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sql } from './fixtures'
import { linkedRepo } from './velvet-cli'

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
    INSERT INTO issue (workspace_id, key, number, title, position, created_by, project_id)
      SELECT w.id, 'IMG-1', 1, 'Keep the sign-in error visible', 'a', u.id, p.id FROM workspace w JOIN project p ON p.workspace_id = w.id, app_user u
      WHERE w.slug = '${slug}' AND p.key = 'portal' AND u.email = '${email}';
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

/** What an agent does with a user-provided file: velvet upload-image from a
 *  repository linked to the portal project. */
async function cliUpload(baseURL: string, target: string[], name: string, bytes: Buffer, relevance: string) {
  await mkdir(resolve('test-results'), { recursive: true })
  const path = resolve('test-results', name)
  await writeFile(path, bytes)
  return linkedRepo(baseURL, email, slug, 'portal').run(['upload-image', ...target, path, '--caption', relevance])
}

/** The image an upload created, read back through the browser session. */
async function listed(page: Page, url: string, relevance: string): Promise<ImageAttachment> {
  const images = (await (await page.request.get(url)).json()).images as ImageAttachment[]
  const image = images.find((candidate) => candidate.caption === relevance)!
  expect(image).toBeDefined()
  return image
}

async function assertImageLoaded(page: Page, captionText: string) {
  const image = page.getByRole('img', { name: captionText, exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
}

test('an agent preserves a shared image on its ticket and portal removal is explicit', async ({ page, playwright, baseURL }) => {
  const bytes = await sharedScreenshot(page, 'Ticket reference: the error disappears after submitting.')
  const anonymous = await playwright.request.newContext({ baseURL })
  try {
    const uploaded = await cliUpload(baseURL!, ['IMG-1'], 'user-sign-in-reference.png', bytes, caption)
    expect(uploaded.code, uploaded.err).toBe(0)
    expect(uploaded.out).toContain('Status unchanged')
    const image = await listed(page, `/api/v1/w/${slug}/issues/IMG-1/images`, caption)
    expect(image.source).toBe('agent')
    expect((await anonymous.get(image.content_url)).status()).toBe(401)
    // The same bytes and caption again are deduplicated, not stored twice.
    expect((await cliUpload(baseURL!, ['IMG-1'], 'user-sign-in-reference.png', bytes, caption)).code).toBe(0)
    const images = (await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1/images`)).json()).images as ImageAttachment[]
    expect(images.filter((candidate) => candidate.caption === caption)).toHaveLength(1)
    const issue = await page.request.get(`/api/v1/w/${slug}/issues/IMG-1`)
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
    await anonymous.dispose()
  }
})

test('CLI uploads to a milestone, with readable responsive previews and read-only viewers', async ({ page, playwright, baseURL }) => {
  const bytes = await sharedScreenshot(page, 'Milestone reference: accepted sign-in design.')
  const result = await cliUpload(baseURL!, ['--milestone', milestoneID], `${'long-user-reference-'.repeat(8)}${suffix}.png`, bytes, caption)
  expect(result.code, result.err).toBe(0)
  const image = await listed(page, `/api/v1/w/${slug}/milestones/${milestoneID}/images`, caption)
  expect(result.out).toContain(image.id)
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

test('non-images are rejected before storage, and a scoped key cannot reach another project', async ({ page, baseURL }) => {
  const before = (await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1/images`)).json()).images.length
  const rejected = await cliUpload(baseURL!, ['IMG-1'], `not-an-image-${suffix}.png`,
    Buffer.from('SYNTHETIC_NON_IMAGE_CONTENT_NOT_A_REAL_SECRET'), 'Not an image.')
  expect(rejected.code).toBe(6)
  expect(rejected.err).toContain('valid PNG, JPEG or WebP')
  expect((await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1/images`)).json()).images).toHaveLength(before)
  expect((await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1`)).json()).status).toBe('backlog')

  // A ticket in another project is out of this repository's reach.
  sql(`
    INSERT INTO project (workspace_id, key, name) SELECT id, 'other', 'Other' FROM workspace WHERE slug = '${slug}';
    INSERT INTO issue (workspace_id, key, number, title, position, created_by, project_id)
      SELECT w.id, 'IMG-2', 2, 'Elsewhere', 'b', u.id, p.id FROM workspace w JOIN project p ON p.workspace_id = w.id, app_user u
      WHERE w.slug = '${slug}' AND p.key = 'other' AND u.email = '${email}';
  `)
  const bytes = await sharedScreenshot(page, 'Should not land.')
  const blocked = await cliUpload(baseURL!, ['IMG-2'], `elsewhere-${suffix}.png`, bytes, 'Should not land.')
  expect(blocked.code).not.toBe(0)
  expect(sql(`SELECT count(*) FROM image_attachment i JOIN issue t ON t.id = i.issue_id WHERE t.key = 'IMG-2'`)).toBe('0')
})

test('JPEG and WebP agent references can be viewed, downloaded and explicitly removed on mobile', async ({ page, baseURL }) => {
  const reference = await sharedScreenshot(page, 'User reference: preserve the visible sign-in error.')
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
    const relevance = `The user shared this ${format.toUpperCase()} reference to show the required sign-in error.`
    const uploaded = await cliUpload(baseURL!, ['IMG-1'], filename, Buffer.from(encoded), relevance)
    expect(uploaded.code, uploaded.err).toBe(0)
    expect(uploaded.out).toContain('Status unchanged')
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
    const approvedCaption = `User-approved ${format.toUpperCase()} reference, uploaded again after removal.`
    const approved = await cliUpload(baseURL!, ['IMG-1'], filename, Buffer.from(encoded), approvedCaption)
    expect(approved.code, approved.err).toBe(0)
    await page.reload()
    await assertImageLoaded(page, approvedCaption)
    expect((await (await page.request.get(`/api/v1/w/${slug}/issues/IMG-1`)).json()).status).toBe('backlog')
  }
})
