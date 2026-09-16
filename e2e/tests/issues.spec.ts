import { test, expect, resetWorkspaceData, seededSessionToken, seedWorkspace, sql } from './fixtures'

test.describe.configure({ mode: 'serial' })

let assigneeId = ''

test.beforeAll(async ({ playwright, baseURL }) => {
  resetWorkspaceData()
  const token = seededSessionToken()
  seedWorkspace(token, 'other')
  sql(`
    INSERT INTO workspace (name, slug, issue_prefix)
    VALUES ('Hidden', 'hidden', 'HID')
    ON CONFLICT (slug) DO NOTHING;
  `)

  const api = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: {
      Cookie: `ticket_session=${token}`,
      Origin: baseURL!,
      'Content-Type': 'application/json',
    },
  })
  assigneeId = (await api.get('/api/v1/me').then((response) => response.json())).user.id as string

  const unfiled = await api.post('/api/v1/w/lab/issues', {
    data: { title: 'Unfiled accessibility audit', priority: 1 },
  })
  expect(unfiled.status()).toBe(201)
  const assigned = await api.post('/api/v1/w/lab/issues', {
    data: { title: 'Assigned todo issue', status: 'todo', priority: 3, assignee_id: assigneeId },
  })
  expect(assigned.status()).toBe(201)
  const done = await api.post('/api/v1/w/lab/issues', {
    data: { title: 'Done launch note', status: 'done', priority: 4 },
  })
  expect(done.status()).toBe(201)
  const other = await api.post('/api/v1/w/other/issues', {
    data: { title: 'Other workspace secret issue', priority: 2 },
  })
  expect(other.status()).toBe(201)
  await api.dispose()
})

test.afterAll(() => {
  sql(`DELETE FROM workspace WHERE slug IN ('other', 'hidden')`)
})

test('navigates the workspace Issues page and completes the issue workflow', async ({ signedIn: page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/w/lab/issues')

  await expect(page.getByRole('heading', { name: 'Issues', exact: true })).toBeVisible()
  const desktopNavigation = page.getByRole('navigation', { name: 'Workspace navigation' })
  await expect(desktopNavigation.getByRole('link', { name: 'Issues' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('Unfiled accessibility audit')).toBeVisible()

  const issueLink = page.getByRole('link', { name: /ENG-1/ })
  await expect(issueLink.getByText('Unfiled', { exact: true })).toBeVisible()
  await expect(issueLink).toHaveAttribute('href', '/w/lab/issues/ENG-1')
  await issueLink.click()
  await expect(page).toHaveURL(/\/w\/lab\/issues\/ENG-1$/)
  await expect(page.getByText('Unfiled accessibility audit')).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Issues', exact: true })).toBeVisible()

  await page.selectOption('[data-testid="issues-status-filter"]', 'todo')
  await page.selectOption('[data-testid="issues-assignee-filter"]', assigneeId)
  await page.selectOption('[data-testid="issues-priority-filter"]', '3')
  await expect(page.getByText('Assigned todo issue')).toBeVisible()
  await expect(page.getByText('Done launch note')).toHaveCount(0)

  await page.getByRole('button', { name: 'New issue' }).click()
  await page.getByLabel('Issue title').fill('Created from Issues page')
  await page.getByRole('button', { name: 'Create issue' }).click()
  await expect(page.getByText('Created from Issues page')).toBeVisible()
  await expect(page.getByTestId('issues-status-filter')).toHaveValue('')
  await expect(page.getByTestId('issues-assignee-filter')).toHaveValue('')
  await expect(page.getByTestId('issues-priority-filter')).toHaveValue('')

  await page.getByTestId('issues-search').fill('Assigned todo')
  await expect(page.getByText('Assigned todo issue')).toBeVisible()
  await expect(page.getByText('Done launch note')).toHaveCount(0)
  await page.getByTestId('issues-clear-filters').click()

  await page.selectOption('[data-testid="issues-status-filter"]', 'todo')
  await page.selectOption('[data-testid="issues-assignee-filter"]', assigneeId)
  await page.selectOption('[data-testid="issues-priority-filter"]', '3')
  await expect(page.getByText('Assigned todo issue')).toBeVisible()
  await expect(page.getByText('Done launch note')).toHaveCount(0)
  await page.getByTestId('issues-clear-filters').click()
  await expect(page.getByText('Done launch note')).toBeVisible()

  await page.screenshot({ path: 'test-results/issues-page-desktop.png', fullPage: true })

  await page.goto('/w/other/issues')
  await expect(page.getByText('Other workspace secret issue')).toBeVisible()
  await expect(page.getByText('Unfiled accessibility audit')).toHaveCount(0)

  const hiddenWorkspace = await request.get('/api/v1/w/hidden/issues')
  expect(hiddenWorkspace.status()).toBe(404)
})

test('keeps the Issues page readable and contained on mobile', async ({ signedIn: page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/w/lab/issues')

  const mobileNavigation = page.getByRole('navigation', { name: 'Mobile navigation' })
  await expect(mobileNavigation.getByRole('link', { name: 'Issues' })).toBeVisible()
  await expect(mobileNavigation.getByRole('link', { name: 'Feed' })).toHaveCount(0)
  await mobileNavigation.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('menu').getByRole('link', { name: 'Team feed' })).toBeVisible()

  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    mainWidth: document.querySelector('main')?.getBoundingClientRect().width ?? 0,
  }))
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth)
  expect(metrics.mainWidth).toBeLessThanOrEqual(metrics.viewportWidth)
  await page.screenshot({ path: 'test-results/issues-page-mobile.png', fullPage: true })
})
