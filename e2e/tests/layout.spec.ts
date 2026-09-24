import { test, expect, resetWorkspaceData, seededSessionToken } from './fixtures'
import type { Locator, Page } from '@playwright/test'

/**
 * Long user text must wrap, never widen the page.
 *
 * The audit that motivated this found an unbroken issue title pushing the
 * dashboard 425px past a phone screen, and a long milestone name stretching the
 * issue rail's milestone picker 459px past a desktop one. Each page below
 * renders the same hostile fixture at the two viewports this repository checks.
 */

test.describe.configure({ mode: 'serial' })

const UNBROKEN = 'Supercalifragilisticexpialidocious_identifier_that_never_breaks_across_lines_in_narrow_viewports'
const LONG_MILESTONE = 'Recap export and the agent-facing work log API that external coding agents call after each session'
const LONG_SPRINT = `October 2026 ${UNBROKEN}`

const ids = { sprint: '', milestone: '', issueKey: '' }

test.beforeAll(async ({ playwright, baseURL }) => {
  resetWorkspaceData()
  const api = await playwright.request.newContext({ baseURL })
  const headers = {
    Cookie: `ticket_session=${seededSessionToken()}`,
    Origin: baseURL!,
    'Content-Type': 'application/json',
  }
  const post = async <T>(path: string, data: unknown = {}): Promise<T> => {
    const res = await api.post(`/api/v1/w/lab${path}`, { headers, data })
    expect(res.ok(), `${path} -> ${res.status()}`).toBeTruthy()
    return res.json() as Promise<T>
  }

  const sprint = await post<{ id: string }>('/sprints', { name: 'September 2026', starts_on: '2026-09-01', ends_on: '2026-09-30' })
  await post(`/sprints/${sprint.id}/activate`)
  await post('/sprints', { name: LONG_SPRINT, starts_on: '2026-10-01', ends_on: '2026-10-31' })
  const milestone = await post<{ id: string }>(`/sprints/${sprint.id}/milestones`, { name: LONG_MILESTONE })
  const issue = await post<{ key: string }>('/issues', {
    title: UNBROKEN,
    milestone_id: milestone.id,
    description: `A long token: ${UNBROKEN}\n\n\`\`\`\n${UNBROKEN} ${UNBROKEN}\n\`\`\``,
  })
  await post(`/issues/${issue.key}/comments`, { body: `Progress on ${UNBROKEN}` })

  ids.sprint = sprint.id
  ids.milestone = milestone.id
  ids.issueKey = issue.key
  await api.dispose()
})

test.afterAll(() => resetWorkspaceData())

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

const pages = () => [
  { name: 'dashboard', path: '/w/lab', ready: 'Dashboard' },
  { name: 'projects', path: '/w/lab/projects', ready: 'Projects' },
  { name: 'team feed', path: '/w/lab/feed', ready: 'Team feed' },
  { name: 'sprints', path: '/w/lab/sprints', ready: 'Sprints' },
  { name: 'sprint board', path: `/w/lab/sprints/${ids.sprint}`, ready: 'September 2026' },
  { name: 'milestone', path: `/w/lab/milestones/${ids.milestone}`, ready: LONG_MILESTONE },
  { name: 'issue', path: `/w/lab/issues/${ids.issueKey}`, ready: UNBROKEN },
  { name: 'issues', path: '/w/lab/issues', ready: 'Issues' },
  { name: 'mentions', path: '/w/lab/mentions', ready: 'Mentions' },
  { name: 'unlinked pull requests', path: '/w/lab/unlinked', ready: 'Unlinked PRs' },
  { name: 'reports', path: '/w/lab/reports', ready: 'Reports' },
  { name: 'administration', path: '/w/lab/admin', ready: 'Administration' },
  { name: 'profile', path: '/w/lab/settings/profile', ready: 'Profile' },
  { name: 'work log', path: '/me/worklog', ready: 'Work log' },
]

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`long titles wrap without horizontal overflow at ${viewport.width}px`, async ({ signedIn: page }) => {
    await page.setViewportSize(viewport)
    for (const target of pages()) {
      await page.goto(target.path)
      await expect(page.getByRole('heading', { level: 1, name: target.ready })).toBeVisible()
      await page.waitForLoadState('networkidle')
      expect(await overflow(page), `${target.name} overflowed at ${viewport.width}px`).toBeLessThanOrEqual(0)
    }
  })
}

test('every workspace page fills the main area on a wide monitor', async ({ signedIn: page }) => {
  // A fixed page cap left a wide empty band beside every page on large
  // screens. Each page's root must span the whole padded main region.
  await page.setViewportSize({ width: 2560, height: 1440 })
  for (const target of pages()) {
    await page.goto(target.path)
    await expect(page.getByRole('heading', { level: 1, name: target.ready })).toBeVisible()
    const widths = await page.evaluate(() => {
      const main = document.querySelector('main')!
      const style = getComputedStyle(main)
      const available = main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return { available, root: main.firstElementChild!.getBoundingClientRect().width }
    })
    expect(widths.root, `${target.name} left part of the main area empty`).toBeGreaterThanOrEqual(widths.available - 1)
  }
})

test('public authentication keeps the sign-in task primary at both viewports', async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/signin')
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Velvet' })).toBeVisible()
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.locator('.landing-layout-auth')).toBeVisible()
    await expect(page.locator('.landing-intro')).toBeHidden()
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    await page.screenshot({
      path: `test-results/sign-in-${viewport.width}-light.png`,
      fullPage: true,
    })
  }
})

async function occupiesMultipleLines(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const lineHeight = Number.parseFloat(style.lineHeight)
    return element.getBoundingClientRect().height > lineHeight * 1.5
  })
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`important titles remain fully readable on mobile in ${colorScheme} mode`, async ({ signedIn: page }) => {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/w/lab/sprints')
    const sprintName = page.getByText(LONG_SPRINT, { exact: true })
    await expect(sprintName).toBeVisible()
    expect(await occupiesMultipleLines(sprintName)).toBe(true)

    await page.goto(`/w/lab/sprints/${ids.sprint}`)
    const milestoneName = page.getByText(LONG_MILESTONE, { exact: true })
    const sprintIssueTitle = page.getByText(UNBROKEN, { exact: true })
    await expect(milestoneName).toBeVisible()
    await expect(sprintIssueTitle).toBeVisible()
    expect(await occupiesMultipleLines(milestoneName)).toBe(true)
    expect(await occupiesMultipleLines(sprintIssueTitle)).toBe(true)
    const sprintPriority = page.getByLabel(/^Priority P/).first()
    const [sprintTitleBox, sprintPriorityBox] = await Promise.all([
      sprintIssueTitle.boundingBox(),
      sprintPriority.boundingBox(),
    ])
    expect(sprintPriorityBox!.y).toBeGreaterThanOrEqual(
      sprintTitleBox!.y + sprintTitleBox!.height - 1,
    )

    await page.goto(`/w/lab/milestones/${ids.milestone}`)
    const milestoneIssues = page.getByRole('listbox')
    const milestoneIssueTitle = milestoneIssues.getByText(UNBROKEN, { exact: true })
    const milestoneIssueStatus = milestoneIssues.getByText('Backlog', { exact: true })
    await expect(milestoneIssueTitle).toBeVisible()
    expect(await occupiesMultipleLines(milestoneIssueTitle)).toBe(true)
    const [milestoneTitleBox, milestoneStatusBox] = await Promise.all([
      milestoneIssueTitle.boundingBox(),
      milestoneIssueStatus.boundingBox(),
    ])
    expect(milestoneStatusBox!.y).toBeGreaterThanOrEqual(
      milestoneTitleBox!.y + milestoneTitleBox!.height - 1,
    )
    expect(await overflow(page)).toBeLessThanOrEqual(0)
  })
}

test('the issue rail keeps the milestone picker inside the rail', async ({ signedIn: page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/w/lab/issues/${ids.issueKey}`)
  const rail = page.getByTestId('issue-sidebar')
  const picker = page.getByTestId('issue-milestone-picker')
  await expect(picker).toBeVisible()

  const railBox = await rail.boundingBox()
  const pickerBox = await picker.boundingBox()
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(railBox!.x + railBox!.width + 1)
})

test('a failed load says so and recovers with Try again', async ({ signedIn: page }) => {
  let fail = true
  await page.route('**/api/v1/w/lab/activity**', (route) =>
    fail
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal","message":"boom"}}' })
      : route.continue(),
  )
  await page.goto('/w/lab/feed')

  await expect(page.getByRole('alert')).toHaveText('Could not load the team feed.', { timeout: 15_000 })
  await expect(page.getByText('Nothing here yet')).toHaveCount(0)

  fail = false
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText(UNBROKEN).first()).toBeVisible()
})

test('missing records and routes say not found and offer a way back', async ({ signedIn: page }) => {
  for (const [path, heading, back] of [
    ['/w/lab/issues/ENG-9999', 'Issue not found', 'Back to issues'],
    ['/w/lab/sprints/00000000-0000-0000-0000-000000000000', 'Sprint not found', 'Back to sprints'],
    ['/w/lab/no-such-page', 'Page not found', 'Back to the dashboard'],
  ] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await expect(page.getByRole('link', { name: back })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  }
})
