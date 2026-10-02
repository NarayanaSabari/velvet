import { test as base, expect, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { sql } from './fixtures'
import { control, deliver, invite } from './onboarding-helpers'

type Accounts = {
  first: string
  second: string
  ownerID: string
  ownerEmail: string
  globalLogin: string
  memberToken: string
  viewerToken: string
  installation: number
}

const test = base.extend<{ accounts: Accounts }>({
  accounts: async ({ page, baseURL }, use) => {
    const suffix = randomUUID().slice(0, 8)
    const first = `accounts-a-${suffix}`
    const second = `accounts-b-${suffix}`
    const ownerEmail = `accounts-owner-${suffix}@example.test`
    const globalLogin = `global-${suffix}`
    const globalID = 9000000 + Number.parseInt(suffix, 16)
    const installation = 100000000 + Number.parseInt(suffix, 16)
    const ownerToken = `accounts-owner-${randomUUID()}`
    const memberToken = `accounts-member-${randomUUID()}`
    const viewerToken = `accounts-viewer-${randomUUID()}`
    const hash = (token: string) => createHash('sha256').update(token).digest('hex')
    sql(`
      INSERT INTO workspace (slug, name, issue_prefix) VALUES
        ('${first}', 'Client A', 'CAA'), ('${second}', 'Client B', 'CBB');
      INSERT INTO app_user (email, name, github_id, github_login) VALUES
        ('${ownerEmail}', 'Account owner', ${globalID}, '${globalLogin}'),
        ('accounts-member-${suffix}@example.test', 'Email-only member', NULL, NULL),
        ('accounts-viewer-${suffix}@example.test', 'Email-only viewer', NULL, NULL);
      INSERT INTO membership (workspace_id, user_id, role)
        SELECT w.id, u.id, CASE WHEN u.email='${ownerEmail}' THEN 'admin'::membership_role
          WHEN u.name='Email-only member' THEN 'member'::membership_role ELSE 'viewer'::membership_role END
        FROM workspace w, app_user u WHERE w.slug IN ('${first}', '${second}')
          AND u.email IN ('${ownerEmail}', 'accounts-member-${suffix}@example.test', 'accounts-viewer-${suffix}@example.test');
      INSERT INTO session (id, user_id, expires_at)
        SELECT CASE WHEN email='${ownerEmail}' THEN '${hash(ownerToken)}'
          WHEN name='Email-only member' THEN '${hash(memberToken)}' ELSE '${hash(viewerToken)}' END,
          id, now()+interval '2 hours' FROM app_user
        WHERE email IN ('${ownerEmail}', 'accounts-member-${suffix}@example.test', 'accounts-viewer-${suffix}@example.test');
      INSERT INTO github_installation (id, account_login, workspace_id, ownership_verified_at, repos_synced_at)
        SELECT ${installation}, 'client-a-repositories', id, now(), now() FROM workspace WHERE slug='${first}';
      INSERT INTO github_installation (id, account_login, workspace_id, ownership_verified_at, repos_synced_at)
        SELECT ${installation + 1}, 'client-b-repositories', id, now(), now() FROM workspace WHERE slug='${second}';
      INSERT INTO repo (workspace_id, installation_id, github_id, owner, name, synced_at)
        SELECT id, ${installation}, ${installation}, 'client-a-repositories', 'portal', now() FROM workspace WHERE slug='${first}';
      INSERT INTO repo (workspace_id, installation_id, github_id, owner, name, synced_at)
        SELECT id, ${installation + 1}, ${installation + 1}, 'client-b-repositories', 'service', now() FROM workspace WHERE slug='${second}';
      INSERT INTO pull_request (workspace_id, repo_id, number, title, state, author_login, html_url, gh_created_at, gh_updated_at)
        SELECT workspace_id, id, 17, 'Client A existing proof', 'open', 'runtime-client-a',
          'https://github.com/client-a-repositories/portal/pull/17', now(), now() FROM repo WHERE installation_id=${installation};
      INSERT INTO pr_review (workspace_id, pull_request_id, github_id, reviewer_login, state, submitted_at)
        SELECT workspace_id, id, ${installation}, 'runtime-client-a', 'APPROVED', now()
          FROM pull_request WHERE repo_id=(SELECT id FROM repo WHERE installation_id=${installation});
    `)
    const ownerID = sql(`SELECT id FROM app_user WHERE email='${ownerEmail}'`)
    await page.context().addCookies([{ name: 'ticket_session', value: ownerToken, url: baseURL! }])
    try {
      await use({ first, second, ownerID, ownerEmail, globalLogin, memberToken, viewerToken, installation })
    } finally {
      await control(page.request, { identityID: 70007 })
      sql(`
        DELETE FROM github_event WHERE payload->'installation'->>'id' IN ('${installation}', '${installation + 1}');
        DELETE FROM workspace WHERE slug IN ('${first}', '${second}');
        DELETE FROM github_installation WHERE id IN (${installation}, ${installation + 1});
        DELETE FROM app_user WHERE email IN ('${ownerEmail}', 'accounts-member-${suffix}@example.test', 'accounts-viewer-${suffix}@example.test');
      `)
    }
  },
})

async function effective(page: Page, slug: string) {
  const response = await page.request.get(`/api/v1/w/${slug}/me/github`)
  expect(response.status()).toBe(200)
  return (await response.json()).identity
}

async function link(page: Page, slug: string, identityID: number) {
  await control(page.request, { identityID })
  await page.goto(`/api/v1/w/${slug}/me/github/link`)
}

test('scoped OAuth keeps the global account and other organisation unchanged', async ({ page, accounts }) => {
  const { first, second, globalLogin, ownerID } = accounts
  await page.goto(`/w/${first}/settings/profile/github`)
  await control(page.request, { identityID: 70008 })
  const completed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/github/callback')
  await page.getByRole('region', { name: 'GitHub identity for Client A', exact: true }).getByRole('link', { name: 'Change account', exact: true }).click()
  await completed
  const global = await page.request.get('/api/v1/me').then((response) => response.json())
  expect(global.user.github_login, 'linking Client A must not replace the global account').toBe(globalLogin)
  await expect(page).toHaveURL(`/w/${first}/settings/profile/github`)
  expect(await effective(page, first)).toMatchObject({ github_login: 'runtime-client-a', source: 'organisation' })
  expect(await effective(page, second)).toMatchObject({ github_login: globalLogin, source: 'global' })
  expect(sql(`SELECT author_id FROM pull_request WHERE repo_id=(SELECT id FROM repo WHERE installation_id=${accounts.installation})`)).toBe(ownerID)
  expect(sql(`SELECT reviewer_id FROM pr_review WHERE github_id=${accounts.installation}`)).toBe(ownerID)

  await page.goto(`/w/${first}/admin/members`)
  await expect(page.getByText(`${accounts.ownerEmail} · @runtime-client-a`, { exact: true })).toBeVisible()
  await expect(page.getByText(`${accounts.ownerEmail} · @${globalLogin}`, { exact: true })).toHaveCount(0)

  await link(page, second, 70009)
  await expect(page).toHaveURL(`/w/${second}/settings/profile/github`)
  expect(await effective(page, second)).toMatchObject({ github_login: 'runtime-client-b', source: 'organisation' })
  expect(await effective(page, first)).toMatchObject({ github_login: 'runtime-client-a', source: 'organisation' })
  expect((await page.request.get('/api/v1/me').then((response) => response.json())).user.github_login).toBe(globalLogin)

  await page.goto(`/w/${first}/settings/profile/github`)
  const section = page.getByRole('region', { name: /GitHub.*Client A|Client A.*GitHub/i })
  await expect(section).toContainText('@runtime-client-a')
  await section.getByRole('button', { name: 'Remove organisation link', exact: true }).click()
  await section.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await effective(page, first)).github_login).toBe('runtime-client-a')
  await section.getByRole('button', { name: 'Remove organisation link', exact: true }).click()
  await section.getByRole('button', { name: 'Confirm remove organisation link', exact: true }).click()
  await expect(section).toContainText(`@${globalLogin}`)
  expect(await effective(page, first)).toMatchObject({ github_login: globalLogin, source: 'global' })
  expect((await effective(page, second)).github_login).toBe('runtime-client-b')
  expect(sql(`SELECT author_id FROM pull_request WHERE repo_id=(SELECT id FROM repo WHERE installation_id=${accounts.installation})`)).toBe(ownerID)
})

test('changing an organisation account and removing the global fallback preserve other links', async ({ page, accounts }) => {
  const { first, second, globalLogin } = accounts
  await link(page, first, 70008)
  await link(page, second, 70009)
  await page.goto(`/w/${first}/settings/profile/github`)
  await control(page.request, { identityID: 70009 })
  const completed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/github/callback')
  await page.getByRole('link', { name: 'Change account', exact: true }).click()
  await completed
  await expect(page).toHaveURL(`/w/${first}/settings/profile/github`)
  expect((await effective(page, first)).github_login).toBe('runtime-client-b')
  expect((await effective(page, second)).github_login).toBe('runtime-client-b')
  expect((await page.request.get('/api/v1/me').then((response) => response.json())).user.github_login).toBe(globalLogin)

  await page.getByRole('button', { name: 'Unlink GitHub profile', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm unlink GitHub profile', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Link GitHub profile', exact: true })).toBeVisible()
  expect((await page.request.get('/api/v1/me').then((response) => response.json())).user.github_login).toBeNull()
  expect((await effective(page, first)).github_login).toBe('runtime-client-b')
  expect((await effective(page, second)).github_login).toBe('runtime-client-b')
})

test('email-only members create and update project tickets while viewers read synced proof without GitHub access', async ({ page, browser, baseURL, accounts }) => {
  const { first, second, installation } = accounts
  const memberContext = await browser.newContext({ baseURL })
  const viewerContext = await browser.newContext({ baseURL })
  await memberContext.addCookies([{ name: 'ticket_session', value: accounts.memberToken, url: baseURL! }])
  await viewerContext.addCookies([{ name: 'ticket_session', value: accounts.viewerToken, url: baseURL! }])
  const member = await memberContext.newPage()
  const viewer = await viewerContext.newPage()
  try {
    for (const person of [member, viewer]) {
      expect((await person.request.get('/api/v1/me').then((response) => response.json())).user.github_login).toBeNull()
      expect(await effective(person, first)).toBeNull()
      expect((await person.request.get(`/api/v1/w/${first}/github/connect`, { maxRedirects: 0 })).status()).toBe(403)
    }
    await member.goto(`/w/${first}/projects`)
    await member.getByRole('button', { name: 'New project', exact: true }).click()
    await member.getByLabel('Project name', { exact: true }).fill('Shared delivery')
    await member.getByLabel('Project key').fill('delivery')
    await member.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(member.getByTestId('project-row-delivery')).toContainText('Shared delivery')

    await member.goto(`/w/${first}/issues?project=delivery`)
    await member.locator('header').getByRole('button', { name: 'New issue', exact: true }).click()
    await member.getByLabel('Issue title', { exact: true }).fill('Coordinate delivery without GitHub')
    const created = member.waitForResponse((response) => response.url().endsWith(`/w/${first}/issues`) && response.request().method() === 'POST')
    await member.getByRole('button', { name: 'Create issue', exact: true }).click()
    const issue = await (await created).json() as { id: string; key: string }
    await member.goto(`/w/${first}/issues/${issue.key}`)
    await member.getByPlaceholder('Write an update…').fill('The delivery checklist is ready for review.')
    await member.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(member.getByText('The delivery checklist is ready for review.', { exact: true })).toBeVisible()

    const now = new Date().toISOString()
    await deliver(page.request, 'pull_request', {
      installation: { id: installation }, action: 'opened', number: 23,
      repository: { id: installation, name: 'portal', owner: { login: 'client-a-repositories' } },
      pull_request: {
        number: 23, title: 'Shared delivery proof', state: 'open', draft: false, body: '',
        html_url: 'https://github.com/client-a-repositories/portal/pull/23',
        created_at: now, updated_at: now, user: { login: 'runtime-client-a' },
        head: { ref: `implementation/${issue.key}` }, additions: 1, deletions: 0,
      },
    })
    await viewer.goto(`/w/${first}/issues/${issue.key}`)
    await expect(viewer.getByRole('heading', { level: 1 })).toHaveText('Coordinate delivery without GitHub')
    await expect(viewer.getByText('The delivery checklist is ready for review.', { exact: true })).toBeVisible()
    await expect(viewer.getByRole('link', { name: '#23', exact: true }).first()).toBeVisible()
    await expect(viewer.getByRole('button', { name: 'Edit issue', exact: true })).toHaveCount(0)
    await expect(viewer.getByPlaceholder('Write an update…')).toHaveCount(0)
    expect((await viewer.request.post(`/api/v1/w/${first}/issues`, {
      headers: { Origin: baseURL! }, data: { title: 'Viewer cannot create' },
    })).status()).toBe(403)
    expect((await viewer.request.post(`/api/v1/w/${first}/issues/${issue.key}/comments`, {
      headers: { Origin: baseURL! }, data: { body: 'Viewer cannot comment' },
    })).status()).toBe(403)
    expect((await viewer.request.get(`/api/v1/w/${second}/issues/${issue.key}`)).status()).toBe(404)
    await viewer.goto(`/w/${first}/projects`)
    await expect(viewer.getByTestId('project-row-delivery')).toContainText('Shared delivery')
    await expect(viewer.getByRole('button', { name: 'New project', exact: true })).toHaveCount(0)
    await viewer.getByTestId('project-row-delivery').getByRole('link', { name: '1 open', exact: true }).click()
    await expect(viewer.getByText('Coordinate delivery without GitHub', { exact: true })).toBeVisible()
    expect(sql(`SELECT status FROM issue WHERE id='${issue.id}'`)).toBe('backlog')
  } finally {
    await memberContext.close()
    await viewerContext.close()
  }
})

test('organisation GitHub settings stay scoped, keyboard accessible and contained on desktop and mobile', async ({ page, accounts }) => {
  const { first, second } = accounts
  await link(page, first, 70008)
  await link(page, second, 70009)
  for (const width of [1280, 390]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.goto(`/w/${first}/settings/profile/github`)
      const section = page.getByRole('region', { name: /GitHub.*Client A|Client A.*GitHub/i })
      await expect(section).toContainText('@runtime-client-a')
      await expect(section).toContainText(/optional/i)
      const remove = section.getByRole('button', { name: 'Remove organisation link', exact: true })
      await remove.focus()
      expect(await remove.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
      await page.keyboard.press('Enter')
      await expect(section.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(remove).toBeFocused()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: `test-results/github-accounts-${width}-${colorScheme}.png`, fullPage: true })
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('combobox', { name: 'Organisation', exact: true }).selectOption(second)
  await expect(page).toHaveURL(`/w/${second}`)
  await page.goto(`/w/${second}/settings/profile/github`)
  await expect(page.getByRole('region', { name: /GitHub.*Client B|Client B.*GitHub/i })).toContainText('@runtime-client-b')
  await expect(page.getByText('@runtime-client-a', { exact: true })).toHaveCount(0)
})

test('scoped identity loading and removal errors recover without changing another organisation', async ({ page, accounts }) => {
  test.setTimeout(60000)
  const { first, second, globalLogin } = accounts
  let releaseLoad!: () => void
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
  await page.route(`**/api/v1/w/${first}/me/github`, async (route) => {
    await loadGate
    await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Identity unavailable' } } })
  })
  await page.goto(`/w/${first}/settings/profile/github`)
  const section = page.getByRole('region', { name: 'GitHub identity for Client A', exact: true })
  await expect(section.getByRole('status')).toContainText('Loading organisation GitHub identity')
  await expect(section.getByRole('link', { name: 'Change account', exact: true })).toHaveCount(0)
  releaseLoad()
  await expect(section.getByRole('alert')).toHaveText('Could not load organisation GitHub identity.')
  await page.unroute(`**/api/v1/w/${first}/me/github`)
  await section.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(section).toContainText(`Effective account: @${globalLogin}`)
  await link(page, first, 70008)
  await expect(section).toContainText('@runtime-client-a')
  let releaseRemoval!: () => void
  const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve })
  await page.route(`**/api/v1/w/${first}/me/github`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    await removalGate
    await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Removal paused' } } })
  })
  await section.getByRole('button', { name: 'Remove organisation link', exact: true }).click()
  await section.getByRole('button', { name: 'Confirm remove organisation link', exact: true }).click()
  await expect(section.getByRole('button', { name: 'Removing…', exact: true })).toBeDisabled()
  await expect(section.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  releaseRemoval()
  await expect(section.getByRole('alert')).toContainText('Removal paused')
  expect((await effective(page, first)).github_login).toBe('runtime-client-a')
  expect((await effective(page, second)).github_login).toBe(globalLogin)
  await page.unroute(`**/api/v1/w/${first}/me/github`)
  await section.getByRole('button', { name: 'Confirm remove organisation link', exact: true }).click()
  await expect(section).toContainText('Source: global account fallback')
  await expect(section.getByRole('link', { name: 'Change account', exact: true })).toBeFocused()
})

test('a member cannot claim a colleague’s effective global account in the same organisation', async ({ page, browser, baseURL, accounts }) => {
  await control(page.request, { identityID: 70008 })
  await page.goto('/api/v1/auth/github/link')
  expect((await page.request.get('/api/v1/me').then((response) => response.json())).user.github_login).toBe('runtime-client-a')
  const memberContext = await browser.newContext({ baseURL })
  await memberContext.addCookies([{ name: 'ticket_session', value: accounts.memberToken, url: baseURL! }])
  try {
    const member = await memberContext.newPage()
    await link(member, accounts.first, 70008)
    await expect(member).toHaveURL('/auth/recovery')
    expect(await effective(member, accounts.first)).toBeNull()
    expect((await effective(page, accounts.first)).github_login).toBe('runtime-client-a')
    expect(sql(`SELECT count(*) FROM membership_github_identity WHERE workspace_id=(SELECT id FROM workspace WHERE slug='${accounts.first}')`)).toBe('0')
  } finally { await memberContext.close() }
})

test('global linking cannot take an account already claimed by another member’s organisation override', async ({ page, browser, baseURL, accounts }) => {
  const memberContext = await browser.newContext({ baseURL })
  await memberContext.addCookies([{ name: 'ticket_session', value: accounts.memberToken, url: baseURL! }])
  try {
    const member = await memberContext.newPage()
    await link(member, accounts.first, 70008)
    await expect(member).toHaveURL(`/w/${accounts.first}/settings/profile/github`)
    await control(page.request, { identityID: 70008 })
    await page.goto('/api/v1/auth/github/link')
    await expect(page).toHaveURL('/auth/recovery')
    expect((await page.request.get('/api/v1/me').then((response) => response.json())).user.github_login).toBe(accounts.globalLogin)
    expect((await effective(page, accounts.first)).github_login).toBe(accounts.globalLogin)
    expect((await effective(member, accounts.first)).github_login).toBe('runtime-client-a')
  } finally { await memberContext.close() }
})

test('invited members can join and work when their global account is already attributed to another member here', async ({ page, browser, baseURL, accounts }) => {
  await link(page, accounts.first, 70008)
  const suffix = randomUUID().slice(0, 8)
  const email = `accounts-invited-${suffix}@example.test`
  const token = `accounts-invited-${randomUUID()}`
  const hash = createHash('sha256').update(token).digest('hex')
  const sha = randomUUID().replaceAll('-', '').padEnd(40, '0')
  sql(`
    INSERT INTO app_user (email, name, github_id, github_login)
      VALUES ('${email}', 'Invited global account owner', 70008, 'runtime-client-a');
    INSERT INTO session (id, user_id, expires_at)
      SELECT '${hash}', id, now()+interval '2 hours' FROM app_user WHERE email='${email}';
    INSERT INTO commit_ref (sha, workspace_id, repo_id, message, author_login, html_url, committed_at)
      SELECT '${sha}', workspace_id, id, 'Invitation account attribution', 'runtime-client-a',
        'https://github.com/client-a-repositories/portal/commit/${sha}', now() FROM repo WHERE installation_id=${accounts.installation};
  `)
  const invitedContext = await browser.newContext({ baseURL })
  await invitedContext.addCookies([{ name: 'ticket_session', value: token, url: baseURL! }])
  try {
    const invitation = await invite(page, accounts.first, email)
    const invited = await invitedContext.newPage()
    await invited.goto(invitation)
    await invited.getByRole('button', { name: 'Accept invitation', exact: true }).click()
    await expect(invited).toHaveURL(`/w/${accounts.first}`)
    const me = await invited.request.get('/api/v1/me').then((response) => response.json())
    expect(me.user.github_login).toBe('runtime-client-a')
    expect(me.memberships).toEqual(expect.arrayContaining([expect.objectContaining({ workspace_slug: accounts.first, role: 'member' })]))
    expect(await effective(invited, accounts.first)).toBeNull()
    expect((await effective(page, accounts.first)).github_login).toBe('runtime-client-a')
    expect(await page.request.get(`/api/v1/me/worklog?workspace=${accounts.first}`).then((response) => response.text())).toContain('Invitation account attribution')
    expect(await invited.request.get(`/api/v1/me/worklog?workspace=${accounts.first}`).then((response) => response.text())).not.toContain('Invitation account attribution')
    await invited.goto(`/w/${accounts.first}/settings/profile/github`)
    await expect(invited.getByText('No effective GitHub identity for this organisation.', { exact: true })).toBeVisible()
    await expect(invited.getByText(/Your global account is not available as a fallback here/)).toBeVisible()
    await invited.goto(`/w/${accounts.first}/issues`)
    await invited.locator('header').getByRole('button', { name: 'New issue', exact: true }).click()
    await invited.getByLabel('Issue title', { exact: true }).fill('Joining does not require GitHub access')
    await invited.getByRole('button', { name: 'Create issue', exact: true }).click()
    await expect(invited.getByText('Joining does not require GitHub access', { exact: true })).toBeVisible()
  } finally {
    await invitedContext.close()
    sql(`DELETE FROM app_user WHERE email='${email}'`)
  }
})
