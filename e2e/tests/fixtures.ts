import { test as base, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export function compose(args: string[]): string {
  return execFileSync('bash', [resolve(here, '..', 'stack-common.sh'), ...args], {
    encoding: 'utf8',
  }).trim()
}

export const WEBHOOK_SECRET = 'e2e-webhook-secret'

/** Runs SQL inside the stack's Postgres and returns stdout. */
export function sql(statement: string): string {
  return compose([
    'exec', '-T', 'postgres',
    'psql', '-U', 'worklog', '-d', 'worklog', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', statement,
  ])
}

/**
 * Seeds a workspace, a member, and a live session, then returns the raw token.
 *
 * Evidence and workflow specs start with a valid email identity and session.
 * onboarding.spec.ts separately exercises email signup and GitHub ownership
 * authorization through the local provider, without seeded sessions or repos.
 *
 * The workspace name is upserted rather than skipped on conflict, for the same
 * reason seedRepo below upserts: the rename spec renames `lab` and the stack is
 * reused, so DO NOTHING left the previous run's name in place and the second
 * run failed on an assertion the first run had invalidated.
 */
export function seedWorkspace(token: string, slug = 'lab'): void {
  const hashed = createHash('sha256').update(token).digest('hex')
  sql(`
    INSERT INTO workspace (name, slug, issue_prefix)
    VALUES ('Lab', '${slug}', 'ENG')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name;

    INSERT INTO app_user (email, github_id, github_login, name)
    VALUES ('sabari@example.test', 1, 'sabari', 'Sabari')
    ON CONFLICT (github_id) DO NOTHING;

    INSERT INTO membership (workspace_id, user_id, role)
    SELECT w.id, u.id, 'admin'
    FROM workspace w, app_user u
    WHERE w.slug = '${slug}' AND u.github_id = 1
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

    INSERT INTO session (id, user_id, expires_at)
    SELECT '${hashed}', u.id, now() + interval '2 hours'
    FROM app_user u WHERE u.github_id = 1
    ON CONFLICT (id) DO NOTHING;
  `)
}

/** Links a repository so webhook deliveries can be attributed to a workspace. */
export function seedRepo(githubId = 555, slug = 'lab'): void {
  // The repo row selects from workspace, so the workspace has to exist first.
  // On a cold stack no test has signed in yet, and the insert silently
  // matched nothing.
  seededSessionToken()

  // Both rows are upserted rather than skipped on conflict. A plain DO NOTHING
  // was subtly wrong: TRUNCATE ... CASCADE removes the repo but the
  // installation can survive, and the conflict then skipped the insert that
  // would have recreated the repo, leaving deliveries unattributable.
  sql(`
    INSERT INTO github_installation (id, account_login, workspace_id, ownership_verified_at)
    SELECT 99, 'acme', id, now() FROM workspace WHERE slug = '${slug}'
    ON CONFLICT (id) DO UPDATE SET account_login = EXCLUDED.account_login,
      workspace_id = EXCLUDED.workspace_id, ownership_verified_at = now(), deleted_at = NULL, suspended_at = NULL;

    INSERT INTO repo (workspace_id, installation_id, github_id, owner, name)
    SELECT w.id, 99, ${githubId}, 'acme', 'widgets' FROM workspace w WHERE w.slug = '${slug}'
    ON CONFLICT (github_id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id, installation_id = EXCLUDED.installation_id;
  `)

  const repos = sql(`SELECT count(*) FROM repo WHERE github_id = ${githubId}`)
  if (repos !== '1') {
    throw new Error(`seedRepo left ${repos} repos; deliveries would be dropped as unattributable`)
  }
}

/**
 * Clears the work a spec file creates, leaving the workspace, member, and
 * session in place.
 *
 * The suite shares one stack for speed, so without this the specs inherit each
 * other's rows and start asserting on data they did not create. Ordering
 * follows the foreign keys, and activity goes last because everything writes
 * to it.
 */
export function resetWorkspaceData(): void {
  // The reset leaves workspace, member, and session intact, but seeding those
  // first means a spec file that resets before anything has signed in still
  // ends up with a usable workspace to insert against.
  seededSessionToken()

  sql(`
    TRUNCATE login_token, pr_link, pr_review, commit_ref, pull_request, repo, github_installation,
             github_event, job, comment_mention, comment, issue_label, label,
             sprint_snapshot, milestone, sprint, issue, activity
    RESTART IDENTITY CASCADE;
    UPDATE workspace SET issue_counter = 0;
  `)
}

/** Signs a webhook body the way GitHub does, so the real HMAC path is used. */
export function signWebhook(body: string): string {
  return 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')
}

export const test = base.extend<{ signedIn: Page }>({
  // The API context carries the same session cookie as the browser, so a spec
  // can set work up over HTTP and then read it in the UI without the two
  // disagreeing about who is signed in.
  request: async ({ playwright, baseURL }, use) => {
    const token = seededSessionToken()
    const context = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Cookie: `ticket_session=${token}`, Origin: baseURL!, 'Content-Type': 'application/json' },
    })
    await use(context)
    await context.dispose()
  },

  signedIn: async ({ page, baseURL }, use) => {
    const token = seededSessionToken()
    const url = new URL(baseURL!)
    await page.context().addCookies([
      { name: 'ticket_session', value: token, domain: url.hostname, path: '/' },
    ])
    await use(page)
  },
})

/**
 * One session is reused for the whole run. Seeding a new one per test would
 * work too, but a stable token keeps the API and browser contexts trivially
 * in agreement.
 */
let cachedToken: string | undefined
export function seededSessionToken(): string {
  if (!cachedToken) {
    cachedToken = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
    seedWorkspace(cachedToken)
  }
  return cachedToken
}

export { expect }
