import { test, expect, type Page } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from './fixtures'

/**
 * Each project runs its own sprints, and a ticket links to a project and a
 * milestone that always agree. Driven in the browser on a throwaway
 * organisation, so the shared `lab` data other specs rely on is untouched.
 */
const id = randomBytes(4).toString('hex')
const slug = `sprint-proj-${id}`
const email = `sprint-proj.${id}@example.test`
const session = `sprint-proj-${id}`

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  sql(`
    INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Sprint Projects', '${slug}', 'SPR');
    INSERT INTO app_user (email, name) VALUES ('${email}', 'Paula Planner');
    INSERT INTO membership (workspace_id, user_id, role)
      SELECT w.id, u.id, 'admin' FROM workspace w, app_user u WHERE w.slug = '${slug}' AND u.email = '${email}';
    INSERT INTO session (id, user_id, expires_at)
      SELECT '${createHash('sha256').update(session).digest('hex')}', id, now() + interval '1 hour' FROM app_user WHERE email = '${email}';
    INSERT INTO project (workspace_id, key, name)
      SELECT w.id, p.key, p.name FROM workspace w, (VALUES ('web', 'Web app'), ('api', 'Public API')) AS p(key, name)
      WHERE w.slug = '${slug}';
  `)
})

test.afterAll(() => {
  sql(`
    DELETE FROM workspace WHERE slug = '${slug}';
    DELETE FROM app_user WHERE email = '${email}';
  `)
})

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'ticket_session', value: session, url: baseURL! }])
})

async function createSprint(page: Page, project: string, name: string, startsOn: string, endsOn: string) {
  await page.goto(`/w/${slug}/sprints`)
  await page.getByRole('button', { name: 'New sprint' }).click()
  await page.getByLabel('Project').selectOption({ label: project })
  await page.getByLabel('Sprint name').fill(name)
  await page.getByLabel('Starts on').fill(startsOn)
  await page.getByLabel('Ends on').fill(endsOn)
  const created = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/w/${slug}/sprints`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create sprint' }).click()
  expect((await created).status()).toBe(201)
}

async function openSprint(page: Page, projectKey: string, name: string) {
  await page.goto(`/w/${slug}/sprints`)
  await page.getByTestId(`sprint-project-${projectKey}`).getByRole('option', { name: new RegExp(name) }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

test('each project runs its own sprint, one active at a time', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  // The form will not create a sprint until a project is chosen.
  await page.goto(`/w/${slug}/sprints`)
  await page.getByRole('button', { name: 'New sprint' }).click()
  await expect(page.getByLabel('Project')).toHaveValue('')
  await page.getByLabel('Sprint name').fill('Unowned')
  await page.getByLabel('Starts on').fill('2026-09-01')
  await page.getByLabel('Ends on').fill('2026-09-30')
  await page.getByRole('button', { name: 'Create sprint' }).click()
  expect(await page.getByLabel('Project').evaluate((select: HTMLSelectElement) => select.validity.valid)).toBe(false)

  // Two projects can each run a sprint with the same name.
  await createSprint(page, 'Web app', 'September 2026', '2026-09-01', '2026-09-30')
  await createSprint(page, 'Public API', 'September 2026', '2026-09-01', '2026-09-30')
  await createSprint(page, 'Web app', 'October 2026', '2026-10-01', '2026-10-31')

  await page.goto(`/w/${slug}/sprints`)
  const web = page.getByTestId('sprint-project-web')
  const api = page.getByTestId('sprint-project-api')
  await expect(web.getByRole('heading', { name: 'Web app' })).toBeVisible()
  await expect(web.getByRole('option')).toHaveCount(2)
  await expect(api.getByRole('option')).toHaveCount(1)

  // Both projects' September sprints can be active together.
  await openSprint(page, 'web', 'September 2026')
  await expect(page.getByTestId('sprint-project')).toContainText('Web app')
  await page.getByRole('button', { name: 'Activate sprint' }).click()
  await expect(page.getByText('2026-09-01 to 2026-09-30 · active')).toBeVisible()

  await openSprint(page, 'api', 'September 2026')
  await expect(page.getByTestId('sprint-project')).toContainText('Public API')
  await page.getByRole('button', { name: 'Activate sprint' }).click()
  await expect(page.getByText('2026-09-01 to 2026-09-30 · active')).toBeVisible()

  // Activating Web's October completes Web's September, and leaves the API alone.
  await openSprint(page, 'web', 'October 2026')
  await page.getByRole('button', { name: 'Activate sprint' }).click()
  await expect(page.getByText('2026-10-01 to 2026-10-31 · active')).toBeVisible()
  await page.goto(`/w/${slug}/sprints`)
  await expect(web.getByRole('option', { name: /September 2026/ })).toContainText('completed')
  await expect(api.getByRole('option', { name: /September 2026/ })).toContainText('active')

  // The dashboard shows every project's running sprint.
  await page.goto(`/w/${slug}`)
  const active = page.getByTestId('dashboard-active-sprint')
  await expect(active).toHaveCount(2)
  await expect(active.getByRole('link', { name: 'Public API · September 2026' })).toBeVisible()
  await expect(active.getByRole('link', { name: 'Web app · October 2026' })).toBeVisible()
})

test('a ticket links to a project and a milestone that always agree', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  // A milestone in each project's active sprint.
  for (const [projectKey, sprint, milestone] of [
    ['web', 'October 2026', 'Onboarding polish'],
    ['api', 'September 2026', 'Rate limits'],
  ] as const) {
    await openSprint(page, projectKey, sprint)
    await page.getByRole('button', { name: 'New milestone' }).first().click()
    await page.getByLabel('Milestone name').fill(milestone)
    await page.getByRole('button', { name: 'Create milestone' }).click()
    await expect(page.getByRole('heading', { name: milestone, exact: true })).toBeVisible()
  }

  // A new ticket from the Issues page, with a milestone that brings its project.
  await page.goto(`/w/${slug}/issues`)
  await page.getByRole('button', { name: 'New issue' }).first().click()
  const form = page.getByRole('region', { name: 'New issue' })
  await form.getByLabel('Issue title').fill('Throttle burst traffic')
  await form.getByLabel('Milestone').selectOption({ label: 'Rate limits' })
  await expect(form.getByLabel('Project')).toHaveValue(await optionValue(form.getByLabel('Project'), 'Public API'))
  await form.getByRole('button', { name: 'Create issue' }).click()
  const row = page.getByRole('link', { name: /Throttle burst traffic/ })
  await expect(row.getByTestId(/issue-milestone-/)).toHaveText('api · Rate limits')

  // On the ticket, the project is shown and linked, and both pickers agree.
  await row.click()
  await expect(page.getByTestId('issue-eyebrow')).toContainText('Public API')
  const project = page.getByTestId('issue-project-picker')
  const milestone = page.getByTestId('issue-milestone-picker')
  await expect(project.locator('option:checked')).toHaveText('Public API')
  await expect(milestone.locator('option:checked')).toHaveText('Rate limits')
  await expect(milestone.locator('optgroup[label="Public API · September 2026"]')).toHaveCount(1)
  await expect(milestone.locator('optgroup[label="Web app · October 2026"]')).toHaveCount(1)

  // Choosing a milestone in another project moves the ticket to that project.
  await milestone.selectOption({ label: 'Onboarding polish' })
  await expect(project.locator('option:checked')).toHaveText('Web app')
  await expect(page.getByTestId('issue-eyebrow')).toContainText('Web app')

  // Choosing a different project clears a milestone that no longer fits.
  await project.selectOption({ label: 'Public API' })
  await expect(milestone.locator('option:checked')).toHaveText('Unfiled')
  await expect(project.locator('option:checked')).toHaveText('Public API')

  // Clearing the project leaves the ticket unfiled everywhere.
  await project.selectOption({ label: 'No project' })
  await expect(project.locator('option:checked')).toHaveText('No project')
  await expect(page.getByTestId('issue-eyebrow')).not.toContainText('Public API')

  // The project link in the header opens that project's tickets.
  await project.selectOption({ label: 'Web app' })
  await page.getByTestId('issue-eyebrow').getByRole('link', { name: 'Web app' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/issues\\?project=web$`))
  await expect(page.getByRole('link', { name: /Throttle burst traffic/ })).toBeVisible()

  // The same choices survive a reload, because they were saved.
  await page.getByRole('link', { name: /Throttle burst traffic/ }).click()
  await page.reload()
  await expect(page.getByTestId('issue-project-picker').locator('option:checked')).toHaveText('Web app')
})

test('an active sprint shows only its own project\'s unfiled work', async ({ page, request, baseURL }) => {
  const headers = { Cookie: `ticket_session=${session}`, Origin: baseURL!, 'Content-Type': 'application/json' }
  for (const [title, projectKey] of [['Loose web task', 'web'], ['Loose api task', 'api']]) {
    const created = await request.post(`/api/v1/w/${slug}/issues`, { headers, data: { title, project: projectKey } })
    expect(created.status()).toBe(201)
  }

  await openSprint(page, 'web', 'October 2026')
  await expect(page.getByText('Loose web task')).toBeVisible()
  await expect(page.getByText('Loose api task')).toHaveCount(0)

  await openSprint(page, 'api', 'September 2026')
  await expect(page.getByText('Loose api task')).toBeVisible()
  await expect(page.getByText('Loose web task')).toHaveCount(0)
})

test('the sprint and ticket pages stay inside a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const path of [`/w/${slug}/sprints`, `/w/${slug}`, `/w/${slug}/issues/SPR-1`]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, path).toBeLessThanOrEqual(0)
  }
  await expect(page.getByTestId('issue-project-picker')).toBeVisible()
})

async function optionValue(select: ReturnType<Page['getByLabel']>, label: string) {
  return select.locator('option', { hasText: label }).first().getAttribute('value') as Promise<string>
}
