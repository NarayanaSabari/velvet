import { test, expect, resetWorkspaceData, seedRepo, signWebhook, sql } from './fixtures'

/**
 * Jev suggests which issue unlinked work belongs to, and a person decides.
 *
 * The whole path is real except TypeSafe itself: a signed webhook delivers a
 * pull request whose branch names no issue, the worker asks the local
 * TypeSafe double, and the suggestion appears on Unlinked PRs. Accepting it
 * links the PR as evidence and never moves the issue's status.
 */

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  resetWorkspaceData()
  seedRepo()
})

function pullRequest(number: number, title: string, branch: string) {
  return JSON.stringify({
    installation: { id: 99 },
    action: 'opened',
    number,
    pull_request: {
      number,
      title,
      state: 'open',
      draft: false,
      body: '',
      additions: 10,
      deletions: 2,
      html_url: `https://github.com/acme/widgets/pull/${number}`,
      created_at: '2026-10-01T10:00:00Z',
      updated_at: '2026-10-01T10:00:00Z',
      merged_at: null,
      user: { login: 'sabari' },
      head: { ref: branch },
    },
    repository: { id: 555, name: 'widgets', owner: { login: 'acme' } },
  })
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('a suggested issue links an unlinked PR in one click and leaves status alone', async ({ signedIn: page, request }) => {
  const issue = await request.post('/api/v1/w/lab/issues', { data: { title: 'Cache workspace lookup in the CLI' } })
  expect(issue.status()).toBe(201)
  const { key } = await issue.json()
  await request.post('/api/v1/w/lab/issues', { data: { title: 'Billing export retries' } })

  const body = pullRequest(71, 'Cache the resolved workspace lookup', 'feature/faster-cli')
  const delivery = await request.post('/webhooks/github', {
    headers: {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'jev-1',
      'X-Hub-Signature-256': signWebhook(body),
      'Content-Type': 'application/json',
    },
    data: body,
  })
  expect(delivery.status()).toBe(200)
  await waitFor(() => sql(`SELECT count(*) FROM link_suggestion WHERE issue_id IS NOT NULL`) === '1', 'a suggestion')

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('/w/lab/unlinked')
    await expect(page.getByRole('heading', { level: 1, name: 'Unlinked PRs' })).toBeVisible()
    await expect(page.getByText('Suggested issue:')).toBeVisible()
    await expect(page.getByRole('link', { name: key })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `test-results/jev-suggestion-${viewport.width}.png`, fullPage: true })
  }

  // Nothing is linked until a person chooses.
  expect(sql(`SELECT count(*) FROM pr_link`)).toBe('0')

  await page.getByRole('button', { name: `Link to ${key}` }).click()
  await expect(page.getByText('Nothing unlinked')).toBeVisible()

  expect(sql(`SELECT link_source FROM pr_link`)).toBe('suggested')
  expect(sql(`SELECT status FROM issue WHERE key = '${key}'`)).toBe('backlog')

  await page.goto(`/w/lab/issues/${key}`)
  await expect(page.getByText('Cache the resolved workspace lookup')).toBeVisible()
})

test('a project note gets a suggestion and is filed under the issue with its author', async ({ signedIn: page, request }) => {
  const project = await request.post('/api/v1/w/lab/projects', { data: { key: 'cli', name: 'CLI' } })
  expect(project.status()).toBe(201)
  const issue = await request.post('/api/v1/w/lab/issues', { data: { title: 'Offline mode for the agent' } })
  const { key } = await issue.json()

  const note = await request.post('/api/v1/w/lab/projects/cli/comments', {
    data: { body: 'Started offline mode: the agent now queues entries while disconnected.' },
  })
  expect(note.status()).toBe(201)
  const { id } = await note.json()
  await waitFor(() => sql(`SELECT count(*) FROM link_suggestion WHERE comment_id = '${id}' AND issue_id IS NOT NULL`) === '1', 'a note suggestion')

  await page.goto('/w/lab/unlinked')
  const section = page.getByRole('region', { name: 'Notes that may belong on an issue' })
  await expect(section.getByText('Started offline mode')).toBeVisible()
  await section.getByRole('button', { name: `File under ${key}` }).click()
  await expect(section).toBeHidden()

  await page.goto(`/w/lab/issues/${key}`)
  await expect(page.getByText('Started offline mode: the agent now queues entries while disconnected.')).toBeVisible()
  expect(sql(`SELECT status FROM issue WHERE key = '${key}'`)).toBe('backlog')
})

test('an admin can turn suggestions off, which hides them at once', async ({ signedIn: page, request }) => {
  const issue = await request.post('/api/v1/w/lab/issues', { data: { title: 'Rate limit sign-in emails' } })
  const { key } = await issue.json()
  const body = pullRequest(72, 'Rate limit repeated sign-in emails', 'fix/mail-flood')
  await request.post('/webhooks/github', {
    headers: {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'jev-2',
      'X-Hub-Signature-256': signWebhook(body),
      'Content-Type': 'application/json',
    },
    data: body,
  })
  await waitFor(() => sql(`SELECT count(*) FROM link_suggestion l JOIN issue i ON i.id = l.issue_id WHERE i.key = '${key}'`) === '1', 'a suggestion')

  await page.goto('/w/lab/admin/general')
  const toggle = page.getByRole('checkbox', { name: /suggest which issue/i })
  await expect(toggle).toBeChecked()
  await expect(page.getByText(/sent to TypeSafe/)).toBeVisible()
  await toggle.uncheck()
  await expect(toggle).not.toBeChecked()
  expect(sql(`SELECT jev_suggestions FROM workspace WHERE slug = 'lab'`)).toBe('f')

  await page.goto('/w/lab/unlinked')
  await expect(page.getByText('Rate limit repeated sign-in emails')).toBeVisible()
  await expect(page.getByText('Suggested issue:')).toHaveCount(0)

  await page.goto('/w/lab/admin/general')
  await page.getByRole('checkbox', { name: /suggest which issue/i }).check()
  await expect(page.getByRole('checkbox', { name: /suggest which issue/i })).toBeChecked()
})
