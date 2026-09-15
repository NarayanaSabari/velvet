import { test, expect, resetWorkspaceData, seededSessionToken } from './fixtures'

/**
 * Sprint closing, reports, keyboard navigation, and the monochrome
 * constraint - the parts of the spec that are easy to regress silently.
 */

test.describe.configure({ mode: 'serial' })

// Build the sprint and issue this file asserts on, rather than inheriting
// whatever another spec happened to leave behind.
test.beforeAll(async ({ playwright, baseURL }) => {
  resetWorkspaceData()

  const api = await playwright.request.newContext({ baseURL })
  const token = seededSessionToken()
  const headers = { Cookie: `ticket_session=${token}`, Origin: baseURL!, 'Content-Type': 'application/json' }

  const sprint = await api
    .post('/api/v1/w/lab/sprints', {
      headers,
      data: { name: 'September 2026', starts_on: '2026-09-01', ends_on: '2026-09-30' },
    })
    .then((r) => r.json())
  await api.post(`/api/v1/w/lab/sprints/${sprint.id}/activate`, { headers })
  const milestone = await api
    .post(`/api/v1/w/lab/sprints/${sprint.id}/milestones`, {
      headers,
      data: { name: 'Ship auth' },
    })
    .then((r) => r.json())
  await api.post('/api/v1/w/lab/issues', {
    headers,
    data: { title: 'Implement GitHub OAuth', milestone_id: milestone.id },
  })
  await api.dispose()
})

test('closing a sprint freezes its numbers against later edits', async ({ request }) => {
  const { sprints } = await request.get('/api/v1/w/lab/sprints').then((r) => r.json())
  const sprint = sprints[0]

  const issue = await request.get('/api/v1/w/lab/issues/ENG-1').then((r) => r.json())
  await request.patch(`/api/v1/w/lab/issues/${issue.key}`, { data: { status: 'done' } })

  const close = await request.post(`/api/v1/w/lab/sprints/${sprint.id}/close`)
  expect(close.status()).toBe(200)

  const before = await request
    .get(`/api/v1/w/lab/sprints/${sprint.id}/snapshot`)
    .then((r) => r.json())
  expect(before.issue_counts.done).toBeGreaterThanOrEqual(1)

  // Rewrite history behind the closed sprint.
  await request.patch(`/api/v1/w/lab/issues/${issue.key}`, { data: { status: 'cancelled' } })

  const after = await request
    .get(`/api/v1/w/lab/sprints/${sprint.id}/snapshot`)
    .then((r) => r.json())

  // A later edit must not silently rewrite last month's report.
  expect(after.issue_counts).toEqual(before.issue_counts)
  expect(after.milestones_planned).toBe(before.milestones_planned)
})

test('the reports page renders all four tables', async ({ signedIn: page }) => {
  await page.goto('/w/lab/reports')

  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible()
  await expect(page.getByText(/stale work/i)).toBeVisible()
  await expect(page.getByText(/activity per person/i)).toBeVisible()
  await expect(page.getByText(/milestone completion per sprint/i)).toBeVisible()
  await expect(page.getByText(/issues closed per sprint/i)).toBeVisible()
})

test('the command palette searches an issue title and opens the issue', async ({ signedIn: page }) => {
  await page.goto('/w/lab')

  await page.keyboard.press('Meta+K')
  await expect(page.getByTestId('command-palette')).toBeVisible()

  const input = page.getByTestId('command-palette-input')
  await input.fill('Implement GitHub OAuth')
  await expect(page.getByRole('option', { name: /ENG-1 Implement GitHub OAuth/ })).toBeVisible()

  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/w\/lab\/issues\/ENG-1$/)
  await expect(page.getByText('Implement GitHub OAuth')).toBeVisible()
})

test('lists are keyboard navigable with j, k, and Enter', async ({ signedIn: page }) => {
  await page.goto('/w/lab/sprints')

  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  await list.focus()

  await page.keyboard.press('j')
  // A roving index means the active row is tracked on the listbox itself.
  await expect(list).toHaveAttribute('aria-activedescendant', /.+/)

  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/w\/lab\/sprints\/[0-9a-f-]{36}$/)
})

test('the interface stays monochrome, with colour reserved for meaning', async ({
  signedIn: page,
}) => {
  await page.goto('/w/lab')

  const body = await page.evaluate(() => {
    const s = getComputedStyle(document.body)
    return { bg: s.backgroundColor, fg: s.color }
  })
  expect(body.bg).toBe('rgb(255, 255, 255)')
  expect(body.fg).toBe('rgb(0, 0, 0)')

  // Every rendered colour must be greyscale or one of the three semantic
  // colours. Anything else means a brand colour crept in.
  const offPalette = await page.evaluate(() => {
    const allowed = new Set([
      'rgb(185, 28, 28)', // blocked
      'rgb(180, 83, 9)', // stale
      'rgb(21, 128, 61)', // done
    ])
    const bad: string[] = []
    for (const el of document.querySelectorAll('*')) {
      const c = getComputedStyle(el).color
      const m = c.match(/^rgba?\((\d+), (\d+), (\d+)/)
      if (!m) continue
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
      const grey = r === g && g === b
      if (!grey && !allowed.has(`rgb(${r}, ${g}, ${b})`)) bad.push(c)
    }
    return [...new Set(bad)]
  })
  expect(offPalette).toEqual([])
})

test('dark mode inverts the same palette', async ({ signedIn: page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/w/lab')

  const body = await page.evaluate(() => {
    const s = getComputedStyle(document.body)
    return { bg: s.backgroundColor, fg: s.color }
  })
  expect(body.bg).toBe('rgb(10, 10, 10)')
  expect(body.fg).toBe('rgb(255, 255, 255)')
})

test('the workspace navigation does not consume half a phone screen', async ({ signedIn: page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/w/lab')

  const nav = await page.getByRole('navigation').boundingBox()
  const main = await page.getByRole('main').boundingBox()
  expect(nav?.width).toBe(390)
  expect(main?.x).toBe(0)
})

test('the desktop sidebar stays contained at normal and short viewport heights', async ({ signedIn: page }) => {
  for (const viewport of [
    { width: 1024, height: 900 },
    // A narrower viewport approximates the CSS viewport at increased browser zoom.
    { width: 768, height: 640 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/w/lab')

    const sidebar = page.getByTestId('desktop-sidebar')
    await expect(sidebar).toBeVisible()
    const metrics = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>('[data-testid="desktop-sidebar"]')
      const header = document.querySelector<HTMLElement>('[data-testid="desktop-sidebar-header"]')
      const nav = document.querySelector<HTMLElement>('[data-testid="desktop-sidebar-nav"]')
      const footer = document.querySelector<HTMLElement>('[data-testid="desktop-sidebar-footer"]')
      const main = document.querySelector<HTMLElement>('main')
      if (!sidebar || !header || !nav || !footer || !main) return null

      const sidebarRect = sidebar.getBoundingClientRect()
      const headerRect = header.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      const mainRect = main.getBoundingClientRect()
      const navStyle = getComputedStyle(nav)
      return {
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        sidebarTop: sidebarRect.top,
        sidebarHeight: sidebarRect.height,
        sidebarRight: sidebarRect.right,
        headerTop: headerRect.top,
        footerBottom: footerRect.bottom,
        sidebarBottom: sidebarRect.bottom,
        navOverflowY: navStyle.overflowY,
        navFlexGrow: navStyle.flexGrow,
        mainLeft: mainRect.left,
        mainRight: mainRect.right,
      }
    })

    expect(metrics).not.toBeNull()
    expect(metrics?.viewportHeight).toBe(viewport.height)
    expect(metrics?.viewportWidth).toBe(viewport.width)
    expect(metrics?.sidebarTop).toBe(0)
    expect(metrics?.sidebarHeight).toBe(viewport.height)
    expect(metrics?.headerTop).toBeGreaterThanOrEqual(metrics?.sidebarTop ?? 0)
    expect(metrics?.footerBottom).toBeLessThanOrEqual(metrics?.sidebarBottom ?? 0)
    expect(metrics?.navOverflowY).toBe('auto')
    expect(metrics?.navFlexGrow).toBe('1')
    expect(metrics?.mainLeft).toBeGreaterThanOrEqual(metrics?.sidebarRight ?? 0)
    expect(metrics?.mainRight).toBeLessThanOrEqual(metrics?.viewportWidth ?? 0)
  }
})

test('uses readable type at 100% zoom without disturbing responsive layout', async ({ signedIn: page }) => {
  for (const viewport of [
    { width: 1720, height: 1040 },
    { width: 1024, height: 640 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/w/lab')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

    const metrics = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>('[data-testid="desktop-sidebar"]')
      const footer = document.querySelector<HTMLElement>('[data-testid="desktop-sidebar-footer"]')
      const nav = document.querySelector<HTMLElement>('[data-testid="desktop-sidebar-nav"]')
      const size = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)
        return element ? getComputedStyle(element).fontSize : null
      }
      const sidebarRect = sidebar?.getBoundingClientRect()
      const footerRect = footer?.getBoundingClientRect()
      const paddingBottom = sidebar ? Number.parseFloat(getComputedStyle(sidebar).paddingBottom) : null

      return {
        body: size('body'),
        heading: size('h1'),
        nav: size('[data-testid="desktop-sidebar-nav"] a'),
        footerButton: size('[data-testid="desktop-sidebar-footer"] > button'),
        formInput: size('details input'),
        formButton: size('details button'),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        footerPinned: sidebarRect && footerRect && paddingBottom !== null
          ? Math.abs(footerRect.bottom - (sidebarRect.bottom - paddingBottom)) < 1
          : false,
        navOverflowY: nav ? getComputedStyle(nav).overflowY : null,
      }
    })

    expect(metrics.body).toBe('16px')
    expect(metrics.heading).toBe('24px')
    expect(Number.parseFloat(metrics.nav ?? '0')).toBeGreaterThanOrEqual(14)
    expect(Number.parseFloat(metrics.footerButton ?? '0')).toBeGreaterThanOrEqual(14)
    expect(metrics.formInput).toBe('16px')
    expect(metrics.formButton).toBe('16px')
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth)
    expect(metrics.footerPinned).toBe(true)
    expect(metrics.navOverflowY).toBe('auto')
  }

  await page.setViewportSize({ width: 1720, height: 1040 })
  await page.goto('/w/lab/issues/ENG-1')
  await expect(page.getByTestId('issue-header')).toBeVisible()
  const issueMetrics = await page.evaluate(() => {
    const size = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      return element ? getComputedStyle(element).fontSize : null
    }
    return {
      key: size('[data-testid="issue-header"] p'),
      heading: size('[data-testid="issue-main"] h1'),
      commentInput: size('textarea'),
      statusButton: size('[data-testid="issue-status-select"] button'),
      select: size('[data-testid="issue-sidebar"] select'),
      metadataLabel: size('[data-testid="issue-metadata"] label > span:first-child'),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }
  })

  expect(issueMetrics.key).toBe('14px')
  expect(issueMetrics.heading).toBe('24px')
  expect(issueMetrics.commentInput).toBe('16px')
  expect(issueMetrics.statusButton).toBe('16px')
  expect(issueMetrics.select).toBe('16px')
  expect(issueMetrics.metadataLabel).toBe('14px')
  expect(issueMetrics.documentWidth).toBeLessThanOrEqual(issueMetrics.viewportWidth)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/w/lab')
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible()
  const mobileMetrics = await page.evaluate(() => {
    const size = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      return element ? getComputedStyle(element).fontSize : null
    }
    const main = document.querySelector<HTMLElement>('main')
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Mobile navigation"]')
    return {
      body: size('body'),
      heading: size('h1'),
      tab: size('nav[aria-label="Mobile navigation"] a'),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      mainLeft: main?.getBoundingClientRect().left ?? null,
      navBottom: nav?.getBoundingClientRect().bottom ?? null,
      viewportHeight: window.innerHeight,
    }
  })

  expect(mobileMetrics.body).toBe('16px')
  expect(mobileMetrics.heading).toBe('24px')
  expect(mobileMetrics.tab).toBe('14px')
  expect(mobileMetrics.documentWidth).toBeLessThanOrEqual(mobileMetrics.viewportWidth)
  expect(mobileMetrics.mainLeft).toBe(0)
  expect(mobileMetrics.navBottom).toBe(mobileMetrics.viewportHeight)
})

test('a lowercase issue URL loads the canonical issue key', async ({ signedIn: page }) => {
  const response = await page.goto('/w/lab/issues/eng-1')
  expect(response?.status()).toBe(200)
  await expect(page.getByTestId('issue-header')).toBeVisible()
  await expect(page.getByTestId('issue-header').getByText('ENG-1', { exact: true })).toBeVisible()
})

test('a deep link survives a hard refresh', async ({ signedIn: page }) => {
  // Without try_files in the Caddyfile this 404s, which is a deployment bug no
  // client-side navigation would ever reveal.
  const res = await page.goto('/w/lab/issues/ENG-1')
  expect(res?.status()).toBe(200)
  await expect(page.getByText('ENG-1')).toBeVisible()
})
