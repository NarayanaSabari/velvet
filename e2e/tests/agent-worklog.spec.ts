import {
  test,
  expect,
  resetWorkspaceData,
  seedRepo,
  seedWorkspace,
  seededSessionToken,
  signWebhook,
  sql,
} from './fixtures'

/**
 * The whole reason this product exists, driven once, in order, as a user
 * actually hits it.
 *
 * Every piece below is covered in isolation somewhere else. What is not
 * covered anywhere else is the chain: an agent logs keyless work against a
 * project with nothing but a token, a real pull request arrives as proof, the
 * entry is promoted into a ticket a manager can schedule, and the recap
 * gathers all of it across two organisations and renders in the browser.
 *
 * A break anywhere in that sequence leaves the product technically passing its
 * per-surface tests while failing the only question being asked of it: what
 * did I work on.
 */

test.describe.configure({ mode: 'serial' })

const AGENT_TOKEN_NAME = 'agent worklog e2e'

test.beforeAll(async () => {
  resetWorkspaceData()
  seedRepo()
  // The second organisation is the point of the recap: work must gather from
  // every membership, not just the one being viewed.
  seedWorkspace(seededSessionToken(), 'client')
  sql(`UPDATE workspace SET name = 'Client' WHERE slug = 'client'`)
  await waitForWorkerReady()
})

test.afterAll(() => {
  // resetWorkspaceData leaves workspaces alone by design, so the extra
  // membership this file adds has to go, or the shell renders a workspace
  // switcher for every later spec.
  sql(`DELETE FROM workspace WHERE slug = 'client'`)
  sql(`DELETE FROM api_token WHERE name = '${AGENT_TOKEN_NAME}'`)
  resetWorkspaceData()
})

/** Proves the worker is draining the queue before anything depends on it. */
async function waitForWorkerReady(timeoutMs = 60_000): Promise<void> {
  sql(`INSERT INTO job (kind, payload) VALUES ('process_delivery', '{"delivery_id":"agent-probe"}'::jsonb)`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (Number(sql("SELECT count(*) FROM job WHERE payload->>'delivery_id' = 'agent-probe'")) === 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('worker never consumed the probe job')
}

async function waitForQueueDrain(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (Number(sql('SELECT count(*) FROM job')) === 0) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('the queue never drained')
}

// The recap answers "what did I do lately", so it filters by date. A
// hardcoded timestamp would drift out of that window and silently stop
// proving anything, so the delivery is dated now, like a real one.
const PR_TIMESTAMP = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

const PR_BODY = JSON.stringify({
  installation: { id: 99 },
  action: 'opened',
  number: 77,
  pull_request: {
    number: 77,
    title: 'Cache the resolved workspace',
    state: 'open',
    draft: false,
    body: '',
    additions: 34,
    deletions: 6,
    html_url: 'https://github.com/acme/widgets/pull/77',
    created_at: PR_TIMESTAMP,
    updated_at: PR_TIMESTAMP,
    merged_at: null,
    user: { login: 'sabari' },
    // Deliberately carries no issue key. This is the keyless case: the agent
    // was working on a project, not a ticket, which is exactly the situation
    // the branch-name linker cannot resolve on its own.
    head: { ref: 'sabari/cache-workspace' },
  },
  repository: { id: 555, name: 'widgets', owner: { login: 'acme' } },
})

test('an agent logs keyless work, proves it with a PR, and it reaches the recap', async ({
  signedIn: page,
  playwright,
  baseURL,
  request,
}) => {
  // --- The agent gets a token, the way a real one would: once, from the UI.
  await page.goto('/w/lab/settings/profile')
  await page.getByLabel('Token name').fill(AGENT_TOKEN_NAME)
  await page.getByRole('button', { name: 'Create token' }).click()
  const token = (await page.getByRole('status').locator('code').textContent())?.trim()
  if (!token) throw new Error('no API token was issued')

  const agent = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
      Origin: baseURL!,
      'Content-Type': 'application/json',
    },
  })

  try {
    // --- The agent finds out where it is from the git remote alone. No
    // VELVET_WORKSPACE, because a coding agent in a fresh checkout has none.
    const resolved = await agent.post('/api/v1/me/resolve-repo', {
      data: { remote: 'git@github.com:acme/widgets.git' },
    })
    expect(resolved.status()).toBe(200)
    const where = await resolved.json()
    expect(where.workspace_slug).toBe('lab')
    // The prefix is what the agent needs to recognise its own ticket keys.
    expect(where.issue_prefix).toBe('ENG')

    // --- A project to log against, created by the agent itself.
    const project = await agent.post('/api/v1/w/lab/projects', {
      data: { name: 'Velvet worklog', key: 'velvet' },
    })
    expect(project.status()).toBe(201)

    // --- The whole point: work logged with no ticket key anywhere.
    const logged = await agent.post('/api/v1/w/lab/projects/velvet/comments', {
      data: { body: 'Cached the resolved workspace so the CLI stops re-resolving every call.' },
    })
    expect(logged.status()).toBe(201)
    const entry = await logged.json()

    // Source is derived from the bearer token, never from the body, so an
    // agent cannot claim to be a human.
    expect(
      sql(`SELECT source FROM comment WHERE id = '${entry.id}'`),
    ).toBe('agent')
    expect(
      Number(sql(`SELECT count(*) FROM comment WHERE id = '${entry.id}' AND api_token_id IS NOT NULL`)),
    ).toBe(1)

    // --- Proof arrives on its own, from GitHub, on a branch naming no issue.
    const delivery = await request.post('/webhooks/github', {
      headers: {
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': `agent-worklog-${Date.now()}`,
        'X-Hub-Signature-256': signWebhook(PR_BODY),
        'Content-Type': 'application/json',
      },
      data: PR_BODY,
    })
    expect(delivery.status()).toBe(200)
    await waitForQueueDrain()

    // Keyless, so nothing auto-linked it. That is correct, not a failure:
    // the agent is the one that knows which work the PR belongs to.
    expect(Number(sql(`SELECT count(*) FROM pr_link pl
      JOIN pull_request pr ON pr.id = pl.pull_request_id WHERE pr.number = 77`))).toBe(0)

    // --- Promote the entry into a ticket, which is how keyless work becomes
    // something a manager can schedule.
    const promoted = await agent.post(`/api/v1/w/lab/comments/${entry.id}/promote`, {
      data: { title: 'Cache the resolved workspace' },
    })
    expect(promoted.status()).toBe(201)
    const issue = await promoted.json()
    expect(issue.key).toMatch(/^ENG-\d+$/)

    // --- Attach the PR as proof, by URL, the way the agent knows it.
    const attached = await agent.post(`/api/v1/w/lab/issues/${issue.key}/evidence`, {
      data: { reference: 'https://github.com/acme/widgets/pull/77' },
    })
    expect(attached.status()).toBe(201)
    expect(Number(sql(`SELECT count(*) FROM pr_link pl
      JOIN pull_request pr ON pr.id = pl.pull_request_id
      JOIN issue i ON i.id = pl.issue_id
      WHERE pr.number = 77 AND i.key = '${issue.key}'`))).toBe(1)

    // The PR is proof, not a controller: promoting and attaching must not have
    // moved the ticket's status on their own.
    expect(sql(`SELECT status FROM issue WHERE key = '${issue.key}'
      AND workspace_id = (SELECT id FROM workspace WHERE slug = 'lab')`)).toBe('todo')

    // --- Work in the other organisation, so the recap has to span both.
    await agent.post('/api/v1/w/client/projects', {
      data: { name: 'Client portal', key: 'portal' },
    })
    const clientEntry = await agent.post('/api/v1/w/client/projects/portal/comments', {
      data: { body: 'Rebuilt the invoice export.' },
    })
    expect(clientEntry.status()).toBe(201)

    // --- The recap, over the API, spanning every organisation.
    const recap = await request.get('/api/v1/me/worklog')
    expect(recap.status()).toBe(200)
    const body = await recap.json()
    const text = JSON.stringify(body)
    expect(text).toContain('Cached the resolved workspace')
    expect(text).toContain('Rebuilt the invoice export')
    expect(text).toContain('Lab')
    expect(text).toContain('Client')

    // The markdown rendering is what gets pasted into a standup, so it must
    // carry the same work rather than being an empty shell.
    const markdown = await request.get('/api/v1/me/worklog.md')
    expect(markdown.status()).toBe(200)
    const md = await markdown.text()
    expect(md).toContain('Cached the resolved workspace')
    expect(md).toContain('Rebuilt the invoice export')

    // --- Finally, the thing the user actually looks at.
    await page.goto('/me/worklog')
    await expect(page.getByText('Cached the resolved workspace').first()).toBeVisible()
    await expect(page.getByText('Rebuilt the invoice export').first()).toBeVisible()
    // Both organisations named, and each day's work grouped under one of them
    // rather than interleaved by raw timestamp. Matched as the group heading
    // specifically: a bare text match also finds the shell's own workspace
    // name, which is hidden at this viewport and proves nothing about grouping.
    await expect(page.getByRole('heading', { level: 3, name: 'Lab' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: 'Client' })).toBeVisible()

    // The evidence has to be reachable from the recap, or it is not proof.
    // The link is labelled by the pull request title, and what matters is
    // that it points at the real pull request on GitHub.
    const evidenceLink = page.getByRole('link', { name: 'Cache the resolved workspace' })
    await expect(evidenceLink).toBeVisible()
    await expect(evidenceLink).toHaveAttribute(
      'href',
      'https://github.com/acme/widgets/pull/77',
    )

    // The page the user reads on a phone must not overflow.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByText('Cached the resolved workspace').first()).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      ),
    ).toBe(false)
  } finally {
    await agent.dispose()
  }
})
