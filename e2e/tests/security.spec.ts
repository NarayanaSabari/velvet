import { randomUUID } from 'node:crypto'
import { test, expect, seedWorkspace, seededSessionToken, sql } from './fixtures'

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`stored Markdown stays inert and readable at ${viewport.width}px`, async ({ signedIn: page, request }) => {
    const slug = `security-${randomUUID().slice(0, 8)}`
    seedWorkspace(seededSessionToken(), slug)
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: viewport.width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' })
    await page.addInitScript(() => {
      Object.assign(window, { securityExecuted: false })
    })
    const description = [
      '## Security reference',
      '<script>window.securityExecuted=true</script>',
      '<img src="/api/v1/health" onerror="window.securityExecuted=true">',
      '<svg onload="window.securityExecuted=true"></svg>',
      '[Unsafe link](javascript:window.securityExecuted=true)',
      '[Safe link](https://example.com/reference)',
      '- [x] Keep safe formatting',
    ].join('\n\n')

    try {
      const created = await request.post(`/api/v1/w/${slug}/issues`, { data: { title: 'Security content', description } })
      expect(created.status()).toBe(201)
      const issue = await created.json() as { key: string }
      const comment = await request.post(`/api/v1/w/${slug}/issues/${issue.key}/comments`, {
        data: { body: 'A safe update.\n\n<img src="/api/v1/health" onerror="window.securityExecuted=true">' },
      })
      expect(comment.status()).toBe(201)
      await page.goto(`/w/${slug}/issues/${issue.key.toLowerCase()}`)
      await expect(page.getByRole('heading', { name: 'Security reference' })).toBeVisible()
      await expect(page.getByText('A safe update.')).toBeVisible()
      await expect(page.getByRole('link', { name: 'Safe link' })).toHaveAttribute('href', 'https://example.com/reference')
      await expect(page.getByRole('checkbox', { name: 'Completed task: Keep safe formatting' })).toBeChecked()
      await expect(page.locator('.markdown script, .markdown [onerror], .markdown [onload], .markdown a[href^="javascript:"]')).toHaveCount(0)
      await expect.poll(() => page.locator('.markdown img').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete))).toBe(true)
      expect(await page.evaluate(() => Reflect.get(window, 'securityExecuted'))).toBe(false)
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
    } finally {
      sql(`DELETE FROM workspace WHERE slug='${slug}'`)
    }
  })
}
