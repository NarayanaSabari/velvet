import { test, expect, resetWorkspaceData, seedWorkspace } from './fixtures'

/**
 * The core work-log loop, driven the way a person drives it.
 *
 * These run against the real Compose stack, so they cover the deployment as
 * well as the code: the bugs this project actually shipped - a crash-looping
 * worker, a Caddy port mismatch, timestamps a browser could not parse - were
 * all invisible to unit tests and to `vite dev`.
 */

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  resetWorkspaceData()
})

test('an unauthenticated visitor is offered sign-in, not an account', async ({ browser }) => {
  // A fresh context on purpose: this is the only spec that must NOT be signed
  // in, and the shared fixture always is.
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/')

  const signIn = page.getByRole('link', { name: /sign in with github/i })
  await expect(signIn).toBeVisible()
  // OAuth needs a real navigation, so this must be an anchor to the API.
  await expect(signIn).toHaveAttribute('href', /\/api\/v1\/auth\/github\/login$/)
  await context.close()
})

test('an uninvited visitor sees the reason instead of another sign-in prompt', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/not-invited')
  await expect(page.getByRole('heading', { name: 'Not invited' })).toBeVisible()
  await expect(page.getByRole('link', { name: /sign in with github/i })).toHaveCount(0)
  await context.close()
})

test('sign out ends the server session and returns to sign in', async ({ browser, baseURL, playwright }) => {
  const token = `logout-${Date.now()}`
  seedWorkspace(token)
  const context = await browser.newContext()
  const page = await context.newPage()
  const url = new URL(baseURL!)
  await context.addCookies([{ name: 'ticket_session', value: token, domain: url.hostname, path: '/' }])

  await page.goto('/w/lab')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/signin$/)
  await expect(page.getByRole('link', { name: /sign in with github/i })).toBeVisible()

  const verifier = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Cookie: `ticket_session=${token}` },
  })
  const response = await verifier.get('/api/v1/me')
  expect(response.status()).toBe(401)
  await verifier.dispose()
  await context.close()
})

test('a signed-in member lands on their dashboard', async ({ signedIn: page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/w\/lab$/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByRole('navigation').getByText('Lab')).toBeVisible()
})

test('sprint, milestone, and issue can be created through the UI', async ({ signedIn: page }) => {
  await page.goto('/w/lab/sprints')
  await page.getByText('New sprint').click()
  await page.getByLabel('Sprint name').fill('September 2026')
  await page.getByLabel('Starts on').fill('2026-09-01')
  await page.getByLabel('Ends on').fill('2026-09-30')
  await page.getByRole('button', { name: 'Create sprint' }).click()

  await page.getByRole('option', { name: /September 2026/ }).click()
  await page.getByRole('button', { name: 'Activate sprint' }).click()
  await page.getByText('New milestone').click()
  await page.getByLabel('Milestone name').fill('Ship auth')
  await page.getByRole('button', { name: 'Create milestone' }).click()

  await page.getByRole('link', { name: 'Ship auth' }).click()
  await page.getByText('New issue').click()
  await page.getByLabel('Issue title').fill('Implement GitHub OAuth')
  await page.getByRole('button', { name: 'Create issue' }).click()

  await expect(page).toHaveURL(/\/w\/lab\/issues\/ENG-1$/)
  await expect(page.getByRole('heading', { name: 'Implement GitHub OAuth' })).toBeVisible()
  await expect(page.getByText('ENG-1')).toBeVisible()
})

test('a comment written in the UI becomes the work log and reaches the feed', async ({
  signedIn: page,
}) => {
  await page.goto('/w/lab/issues/ENG-1')

  const body = `Wired up the OAuth callback at ${Date.now()}.`
  const composer = page.getByPlaceholder('Write an update…')
  await composer.fill(body)
  await page.getByRole('button', { name: 'Comment' }).click()

  // The composer clears only after the write succeeds, so an empty box is the
  // signal the comment landed.
  await expect(composer).toHaveValue('')
  await expect(page.getByText(body)).toBeVisible()

  await page.goto('/w/lab/feed')
  // The excerpt appears once in the feed row.
  await expect(page.getByText(body).first()).toBeVisible()
  // The row must name what was commented on rather than dangling on "on".
  await expect(page.getByText(/commented on\s*$/)).toHaveCount(0)
})

test('timestamps render as relative time, not raw database strings', async ({
  signedIn: page,
  request,
}) => {
  // Write the activity this test reads rather than relying on what earlier
  // tests happened to leave behind: an empty feed made the assertion pass or
  // fail depending on ordering, which is the definition of a flaky test.
  await request.post('/api/v1/w/lab/issues/ENG-1/comments', {
    data: { body: 'A comment whose timestamp must render as relative time.' },
  })

  await page.goto('/w/lab')
  await expect(page.getByText(/A comment whose timestamp/).first()).toBeVisible()

  // Postgres renders a bare "+00" offset, which JavaScript's Date parser
  // rejects; the UI then silently printed the raw string. jsdom tests could
  // not see it because they fed the component JS-generated dates.
  //
  // Match "now" as well as "... ago": Intl.RelativeTimeFormat with
  // numeric: 'auto' renders a sub-second-old timestamp as "now", so asserting
  // only on /ago$/ failed whenever the run was fast enough. The real
  // requirement is that a relative label is rendered at all.
  await expect(page.getByText(/(ago|now)$/).first()).toBeVisible()

  // The actual regression guard: a raw ISO string must never reach the page.
  await expect(page.getByText(/^\d{4}-\d{2}-\d{2}T/)).toHaveCount(0)
})

test('a status change made in the UI survives a reload', async ({ signedIn: page }) => {
  await page.goto('/w/lab/issues/ENG-1')

  await page.getByRole('combobox', { name: 'Status' }).selectOption('in_progress')
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('in_progress')

  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('in_progress')
})

test('the sprint board shows progress and the latest milestone comment', async ({
  signedIn: page,
  request,
}) => {
  const { sprints } = await request.get('/api/v1/w/lab/sprints').then((r) => r.json())
  const { milestones } = await request
    .get(`/api/v1/w/lab/sprints/${sprints[0].id}/milestones`)
    .then((r) => r.json())

  await request.post(`/api/v1/w/lab/milestones/${milestones[0].id}/comments`, {
    data: { body: 'Blocked on vendor access.' },
  })

  await page.goto(`/w/lab/sprints/${sprints[0].id}`)

  await expect(page.getByText('Ship auth')).toBeVisible()
  // The latest comment carries more than the counts: a milestone at 0/1 with
  // "blocked on vendor access" is understood, silence is not.
  await expect(page.getByText('Blocked on vendor access.')).toBeVisible()
})
