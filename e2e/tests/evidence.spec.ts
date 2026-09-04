import { test, expect, resetWorkspaceData, seedRepo, signWebhook, sql } from './fixtures'

/**
 * Pull requests are proof of work, never a controller of it.
 *
 * This is the decision the whole product rests on, so it is asserted through
 * the real path: a signed webhook arrives, the worker links it by branch name,
 * and the issue's status does not move until a human says so.
 */

test.describe.configure({ mode: 'serial' })

// This file owns its data: it delivers webhooks and counts the rows they
// produce, so inheriting another spec's pull requests would make the counts
// meaningless.
test.beforeAll(async () => {
  resetWorkspaceData()
  seedRepo()
  // On a cold stack the worker may still be starting when the first delivery
  // lands. Confirm it is actually consuming before asserting on what it did.
  await waitForWorkerReady()
})

/**
 * Proves the worker is running by watching it consume a probe job, rather than
 * assuming a container that reports "started" is already draining the queue.
 */
async function waitForWorkerReady(timeoutMs = 60_000): Promise<void> {
  sql(`INSERT INTO job (kind, payload) VALUES ('process_delivery', '{"delivery_id":"probe"}'::jsonb)`)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (Number(sql("SELECT count(*) FROM job WHERE payload->>'delivery_id' = 'probe'")) === 0) {
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('worker never consumed the probe job')
}

const PR_OPENED = JSON.stringify({
  action: 'opened',
  number: 42,
  pull_request: {
    number: 42,
    title: 'Wire the activity feed',
    state: 'open',
    draft: false,
    body: '',
    additions: 88,
    deletions: 4,
    html_url: 'https://github.com/acme/widgets/pull/42',
    created_at: '2026-09-04T10:00:00Z',
    updated_at: '2026-09-04T10:00:00Z',
    merged_at: null,
    // Capitalised on purpose: GitHub logins are case-insensitive, and an exact
    // comparison here once dropped the author's credit entirely.
    user: { login: 'Sabari' },
    head: { ref: 'sabari/eng-1-activity-feed' },
  },
  repository: { id: 555, name: 'widgets', owner: { login: 'acme' } },
})

const PR_MERGED = JSON.stringify({
  ...JSON.parse(PR_OPENED),
  action: 'closed',
  pull_request: {
    ...JSON.parse(PR_OPENED).pull_request,
    state: 'closed',
    merged_at: '2026-09-04T11:00:00Z',
    updated_at: '2026-09-04T11:00:00Z',
  },
})

async function deliver(request: import('@playwright/test').APIRequestContext, body: string, id: string) {
  const res = await request.post('/webhooks/github', {
    headers: {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': id,
      'X-Hub-Signature-256': signWebhook(body),
      'Content-Type': 'application/json',
    },
    data: body,
  })
  expect(res.status()).toBe(200)
  await waitForQueueDrain()
}

/**
 * Waits until the worker has processed everything it has been handed.
 *
 * The webhook handler returns before any work happens, by design: it only
 * verifies, stores, and enqueues. A fixed sleep here is either slow or flaky,
 * and on a cold start - when the worker is still booting - it was both.
 */
async function waitForQueueDrain(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pending = Number(sql('SELECT count(*) FROM github_event WHERE processed_at IS NULL'))
    const queued = Number(sql('SELECT count(*) FROM job WHERE NOT dead'))
    if (pending === 0 && queued === 0) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('worker did not drain the queue in time')
}

test('an unsigned webhook is refused and never stored', async ({ request }) => {
  const res = await request.post('/webhooks/github', {
    headers: {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'unsigned-1',
      'Content-Type': 'application/json',
    },
    data: PR_OPENED,
  })

  expect(res.status()).toBe(401)
  // Assert on this delivery rather than a total: the worker processes rows
  // concurrently, so a global count is a moving target and would make this
  // test fail for reasons that have nothing to do with signatures.
  expect(sql("SELECT count(*) FROM github_event WHERE delivery_id = 'unsigned-1'")).toBe('0')
})

test('a tampered body fails the signature check', async ({ request }) => {
  const res = await request.post('/webhooks/github', {
    headers: {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'tampered-1',
      // Signature computed over a different body.
      'X-Hub-Signature-256': signWebhook(PR_OPENED),
      'Content-Type': 'application/json',
    },
    data: PR_MERGED,
  })

  expect(res.status()).toBe(401)
})

test('a signed PR links itself to the issue named by its branch', async ({
  signedIn: page,
  request,
}) => {
  const issue = await request
    .post('/api/v1/w/lab/issues', { data: { title: 'Wire up the activity feed' } })
    .then((r) => r.json())

  await deliver(request, PR_OPENED, 'e2e-open-1')

  const evidence = await request
    .get(`/api/v1/w/lab/issues/${issue.key}/evidence`)
    .then((r) => r.json())

  expect(evidence.pull_requests).toHaveLength(1)
  expect(evidence.pull_requests[0].number).toBe(42)

  await page.goto(`/w/lab/issues/${issue.key}`)
  // #42 appears on the evidence card and again on the timeline, which is
  // correct: the card is the proof, the timeline entry is when it happened.
  await expect(page.getByText('#42').first()).toBeVisible()
  await expect(page.getByText('+88')).toBeVisible()
  await expect(page.getByText('-4')).toBeVisible()
})

test('the feed credits the PR author and names the issue', async ({ signedIn: page }) => {
  await page.goto('/w/lab/feed')

  // "Someone attached PR #42 to an issue" tells a reader nothing they can act
  // on; both halves of the sentence must be filled in.
  await expect(page.getByText(/attached PR/)).toBeVisible()
  await expect(page.getByText(/Someone attached/)).toHaveCount(0)
  await expect(page.getByText(/to an issue\s*$/)).toHaveCount(0)
})

test('a redelivered webhook changes nothing', async ({ request }) => {
  // Scoped to PR #42, the one this file delivers, so the assertion is about
  // idempotency rather than about what else happens to be in the database.
  const snapshot = () => ({
    prs: sql('SELECT count(*) FROM pull_request WHERE number = 42'),
    links: sql(`SELECT count(*) FROM pr_link l
                JOIN pull_request p ON p.id = l.pull_request_id WHERE p.number = 42`),
    attached: sql(`SELECT count(*) FROM activity
                   WHERE verb = 'attached_pr' AND (metadata->>'number')::int = 42`),
  })

  const before = snapshot()
  // Same payload, new delivery id: exactly what GitHub sends after an outage.
  await deliver(request, PR_OPENED, 'e2e-open-replay')

  expect(snapshot()).toEqual(before)
})

test('merging a PR prompts a human instead of completing the issue', async ({
  signedIn: page,
  request,
}) => {
  await deliver(request, PR_MERGED, 'e2e-merge-1')

  const issue = await request.get('/api/v1/w/lab/issues/ENG-1').then((r) => r.json())
  expect(issue.status).not.toBe('done')
  expect(issue.status).toBe('backlog')

  await page.goto('/w/lab/issues/ENG-1')
  await expect(page.getByText(/PR merged - is this issue done\?/)).toBeVisible()

  const markDone = page.getByRole('button', { name: /mark issue done/i })
  await expect(markDone).toBeVisible()

  // Only the click completes it. The record says what the person decided.
  await markDone.click()
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('done')
})
