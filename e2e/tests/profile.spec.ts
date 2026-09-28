import { test, expect, resetWorkspaceData } from './fixtures'

const sections = [
  ['general', 'General'],
  ['github', 'GitHub'],
  ['agent-config', 'Agent config'],
  ['tokens', 'API tokens'],
] as const

const base = '/w/lab/settings/profile'

test.beforeAll(() => resetWorkspaceData())

test('profile sections support legacy links, direct URLs, back and keyboard navigation', async ({ signedIn: page }) => {
  await page.goto(base)
  await expect(page).toHaveURL(`${base}/general`)
  const nav = page.getByRole('navigation', { name: 'Profile sections' })
  for (const [path, heading] of sections) {
    await nav.getByRole('link', { name: heading, exact: true }).click()
    await expect(page).toHaveURL(`${base}/${path}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
    await expect(page).toHaveTitle(`${heading} · Profile · Velvet`)
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
    await expect(nav.getByRole('link', { name: heading, exact: true })).toHaveAttribute('aria-current', 'page')
  }
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agent config')
  await page.goto(`${base}/github`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('GitHub')
  await expect(page.getByLabel('Token name')).toHaveCount(0)

  await nav.getByRole('link', { name: 'General', exact: true }).click()
  await expect(page).toHaveURL(`${base}/general`)
  await nav.getByRole('link', { name: 'General', exact: true }).focus()
  await page.keyboard.press('Tab')
  const github = nav.getByRole('link', { name: 'GitHub', exact: true })
  await expect(github).toBeFocused()
  expect(await github.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`${base}/github`)
  await expect(github).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(nav.getByRole('link', { name: 'Agent config', exact: true })).toBeFocused()

  await page.goto(`${base}?linked=1#agent-config`)
  await expect(page).toHaveURL(`${base}/agent-config?linked=1`)
  await expect(page.getByTestId('agent-mcp-url')).toBeVisible()
  await page.goto(`${base}/unknown`)
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
})

test('leaving token setup never reveals the key again and revocation stays explicit', async ({ signedIn: page, request }) => {
  await page.goto(`${base}/tokens`)
  const name = `Profile route key ${Date.now()}`
  await page.getByLabel('Token name').fill(name)
  await page.getByRole('button', { name: 'Create token' }).click()
  await expect(page.getByRole('status').locator('code')).toHaveText(/^velvet_/)
  const result = await request.get('/api/v1/me/tokens')
  const { tokens } = await result.json() as { tokens: { id: string; name: string }[] }
  const token = tokens.find((candidate) => candidate.name === name)!
  expect(token).toBeDefined()
  try {
    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'General', exact: true }).click()
    await page.goBack()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('API tokens')
    await expect(page.getByText('Token created', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: `Revoke ${name}`, exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm revoke' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByText(name, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: `Revoke ${name}`, exact: true }).click()
    await page.getByRole('button', { name: 'Confirm revoke' }).click()
    await expect(page.getByText(name, { exact: true })).toHaveCount(0)
  } finally {
    await request.delete(`/api/v1/me/tokens/${token.id}`)
  }
})

test('agent keys disappear on back and forward without Done, and remain listed as metadata', async ({ signedIn: page, request }) => {
  await page.goto(`${base}/agent-config`)
  const created = page.waitForResponse((response) => response.url().endsWith('/me/tokens') && response.request().method() === 'POST')
  await page.getByRole('button', { name: /Set up (an|another) agent/ }).click()
  const token = await (await created).json() as { id: string; name: string }
  try {
    await expect(page.getByTestId('agent-token')).toBeVisible()
    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'API tokens', exact: true }).click()
    await expect(page.getByText(token.name, { exact: true })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agent config')
    await expect(page.getByTestId('agent-token')).toHaveCount(0)
    await expect(page.getByTestId('agent-snippet')).toHaveCount(0)
    await page.goForward()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('API tokens')
    await expect(page.getByText('Token created', { exact: true })).toHaveCount(0)
  } finally {
    await request.delete(`/api/v1/me/tokens/${token.id}`)
  }
})

test('token loading, retry, saving and failed confirmation preserve context', async ({ signedIn: page, request }) => {
  let releaseLoad!: () => void
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
  let firstLoad = true
  await page.route('**/api/v1/me/tokens', async (route) => {
    if (firstLoad) {
      firstLoad = false
      await loadGate
    }
    await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Try later' } } })
  })
  await page.goto(`${base}/tokens`)
  await expect(page.getByRole('status')).toContainText('Loading API tokens')
  releaseLoad()
  await expect(page.getByRole('alert')).toHaveText('Could not load API tokens.')
  await page.unroute('**/api/v1/me/tokens')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByLabel('Token name')).toBeVisible()

  const name = `Retained draft ${Date.now()}`
  let releaseCreate!: () => void
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
  await page.route('**/api/v1/me/tokens', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await createGate
    await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Creation paused' } } })
  })
  await page.getByLabel('Token name').fill(name)
  await page.getByRole('button', { name: 'Create token' }).click()
  await expect(page.getByRole('button', { name: 'Creating…' })).toBeDisabled()
  releaseCreate()
  await expect(page.getByRole('alert')).toHaveText('Creation paused')
  await expect(page.getByLabel('Token name')).toHaveValue(name)
  await page.unroute('**/api/v1/me/tokens')
  const created = page.waitForResponse((response) => response.url().endsWith('/me/tokens') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create token' }).click()
  const token = await (await created).json() as { id: string }
  try {
    await page.getByRole('button', { name: 'Dismiss token' }).click()
    await page.route(`**/api/v1/me/tokens/${token.id}`, async (route) => {
      await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Revocation paused' } } })
    })
    await page.getByRole('button', { name: `Revoke ${name}`, exact: true }).click()
    await page.getByRole('button', { name: 'Confirm revoke' }).click()
    await expect(page.getByRole('alert')).toHaveText('Revocation paused')
    await expect(page.getByRole('button', { name: 'Confirm revoke' })).toBeVisible()
    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'General', exact: true }).click()
    await page.goBack()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('API tokens')
    await expect(page.getByRole('button', { name: 'Confirm revoke' })).toHaveCount(0)
  } finally {
    await page.unroute(`**/api/v1/me/tokens/${token.id}`)
    await request.delete(`/api/v1/me/tokens/${token.id}`)
  }
})

for (const width of [1280, 390, 1720]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`profile sections fit ${width}px in ${colorScheme} with reduced motion`, async ({ signedIn: page, request }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : width === 1720 ? 1000 : 900 })
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      for (const [path, heading] of sections) {
        await page.goto(`${base}/${path}`)
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
        if (path === 'tokens') await expect(page.getByLabel('Token name')).toBeVisible()
        if (path === 'agent-config') await expect(page.getByTestId('agent-config-status')).not.toContainText('Checking')
        const nav = page.getByRole('navigation', { name: 'Profile sections' })
        for (const [, label] of sections) await expect(nav.getByRole('link', { name: label, exact: true })).toBeInViewport()
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
        await page.screenshot({ path: `test-results/profile-${path}-${width}-${colorScheme}.png`, fullPage: true })
        if (path === 'tokens') {
          const name = `Long token name ${'without-spaces'.repeat(4)} ${width} ${colorScheme}`
          const response = await request.post('/api/v1/me/tokens', { data: { name } })
          expect(response.ok()).toBe(true)
          const token = await response.json() as { id: string }
          try {
            await page.reload()
            await expect(page.getByText(name, { exact: true })).toBeVisible()
            expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
            await page.screenshot({ path: `test-results/profile-tokens-populated-${width}-${colorScheme}.png`, fullPage: true })
          } finally {
            await request.delete(`/api/v1/me/tokens/${token.id}`)
          }
        }
      }
      if (width === 1720) {
        await page.goto('/w/lab/admin/general')
        await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible()
        await page.screenshot({ path: `test-results/profile-sibling-admin-${colorScheme}.png`, fullPage: true })
      }
    })
  }
}
