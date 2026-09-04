import { test, expect, resetWorkspaceData } from './fixtures'

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

test('a signed-in member lands on their dashboard', async ({ signedIn: page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/w\/lab$/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByRole('navigation').getByText('Lab')).toBeVisible()
})

test('sprint, milestone, and issue can be created and read back', async ({
  signedIn: page,
  request,
}) => {
  const sprint = await request
    .post('/api/v1/w/lab/sprints', {
      data: { name: 'September 2026', starts_on: '2026-09-01', ends_on: '2026-09-30' },
    })
    .then((r) => r.json())

  await request.post(`/api/v1/w/lab/sprints/${sprint.id}/activate`)

  const milestone = await request
    .post(`/api/v1/w/lab/sprints/${sprint.id}/milestones`, { data: { name: 'Ship auth' } })
    .then((r) => r.json())

  const issue = await request
    .post('/api/v1/w/lab/issues', {
      data: { title: 'Implement GitHub OAuth', milestone_id: milestone.id },
    })
    .then((r) => r.json())

  // The counter was reset with the rest of the workspace data, so this is the
  // first issue of the run.
  expect(issue.key).toBe('ENG-1')
  expect(issue.status).toBe('backlog')

  await page.goto(`/w/lab/issues/${issue.key}`)
  await expect(page.getByRole('heading', { name: 'Implement GitHub OAuth' })).toBeVisible()
  await expect(page.getByText(issue.key)).toBeVisible()
})

test('a comment written in the UI becomes the work log and reaches the feed', async ({
  signedIn: page,
}) => {
  await page.goto('/w/lab/issues/ENG-1')

  const body = `Wired up the OAuth callback at ${Date.now()}.`
  await page.getByRole('textbox').fill(body)
  await page.getByRole('button', { name: 'Comment' }).click()

  // The composer clears only after the write succeeds, so an empty box is the
  // signal the comment landed.
  await expect(page.getByRole('textbox')).toHaveValue('')
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
  await expect(page.getByText(/ago$/).first()).toBeVisible()
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
