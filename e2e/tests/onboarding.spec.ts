import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { resetWorkspaceData, sql } from './fixtures'
import { control, createOrganisation, deliver, invite, mailLink, requestSignIn, signup, unique } from './onboarding-helpers'

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => {
  resetWorkspaceData()
  // Prior runs may have linked this synthetic identity. Email accounts persist.
  sql('UPDATE app_user SET github_id=NULL,github_login=NULL WHERE github_id=70007')
})

test('signup, fresh invite acceptance, listed invite, switching and member removal', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000)
  const suffix = unique()
  const owner = `owner-${suffix}@example.test`
  const member = `member-${suffix}@example.test`
  const listed = `listed-${suffix}@example.test`
  const first = `first-${suffix}`
  const second = `second-${suffix}`
  await signup(page, owner)
  await createOrganisation(page, first, 'First organisation')
  const link = await invite(page, first, member)
  const memberContext = await browser.newContext({ baseURL })
  const memberPage = await memberContext.newPage()
  try {
    await memberPage.goto(link)
    await expect(memberPage.getByText(`This invitation is for ${member}.`)).toBeVisible()
    expect((await memberPage.request.get('/api/v1/me')).status()).toBe(401)
    const since = new Date()
    await memberPage.getByRole('button', { name: 'Sign in and accept' }).click()
    await expect(memberPage).toHaveURL(/\/check-email$/)
    const login = await mailLink(member, since, '/signin/confirm')
    await memberPage.goto(login)
    expect((await memberPage.request.get('/api/v1/me')).status()).toBe(401)
    await memberPage.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(memberPage).toHaveURL(new RegExp(`/w/${first}$`))
    await expect(memberPage.getByRole('link', { name: 'Administration' })).toHaveCount(0)
    expect((await memberPage.request.get(`/api/v1/w/${first}/github/connect`, { maxRedirects: 0 })).status()).toBe(403)
    expect((await memberPage.request.post(`/api/v1/w/${first}/github/sync`, {
      headers: { Origin: baseURL!, 'Content-Type': 'application/json' },
    })).status()).toBe(403)

    await createOrganisation(page, second, 'Second organisation')
    await page.getByRole('combobox', { name: 'Organisation', exact: true }).selectOption(first)
    await expect(page).toHaveURL(new RegExp(`/w/${first}$`))
    await page.getByRole('combobox', { name: 'Organisation', exact: true }).selectOption(second)
    await expect(page).toHaveURL(new RegExp(`/w/${second}$`))
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Organisation', exact: true })).toHaveValue(second)
    await invite(page, second, listed)
    const listedContext = await browser.newContext({ baseURL })
    try {
      const listedPage = await listedContext.newPage()
      await signup(listedPage, listed)
      await listedPage.getByRole('button', { name: 'Accept Second organisation invitation' }).click()
      await expect(listedPage).toHaveURL(new RegExp(`/w/${second}$`))
    } finally { await listedContext.close() }

    await page.goto(`/w/${first}/admin`)
    await page.getByRole('button', { name: `Remove ${member}`, exact: true }).click()
    await page.getByRole('button', { name: 'Confirm removal' }).click()
    await expect(page.getByRole('button', { name: `Remove ${member}`, exact: true })).toHaveCount(0)
    expect((await memberPage.request.get(`/api/v1/w/${first}/issues`)).status()).toBe(404)
    await memberPage.reload()
    await expect(memberPage.getByRole('heading', { name: 'Organisation not found' })).toBeVisible()
    await memberPage.goto(link)
    await expect(memberPage.getByRole('heading', { name: 'Link expired' })).toBeVisible()
  } finally { await memberContext.close() }
})

test('expired and reused sign-in links, invite resend and revoke clear earlier errors', async ({ page, browser, baseURL }) => {
  test.setTimeout(120000)
  const suffix = unique()
  const owner = `links-${suffix}@example.test`
  const slug = `links-${suffix}`
  const used = await signup(page, owner)
  await createOrganisation(page, slug, 'Links organisation')
  const recipient = `resend-${suffix}@example.test`
  const original = await invite(page, slug, recipient)
  // HTML email syntax allows consecutive dots; the API mailbox parser rejects them.
  const failInvite = async () => {
    await page.getByLabel('Invite email', { exact: true }).fill('bad..address@example.test')
    await page.getByRole('button', { name: 'Send invite', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
  }
  await failInvite()
  const since = new Date()
  await page.getByRole('button', { name: `Resend invitation to ${recipient}`, exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  const resent = await mailLink(recipient, since, '/invite', original)
  expect(resent).not.toBe(original)
  await failInvite()
  await page.getByRole('button', { name: `Revoke invitation to ${recipient}`, exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Resend invitation to ${recipient}` })).toHaveCount(0)
  const expiredInvite = await invite(page, slug, `expired-invite-${suffix}@example.test`)
  const inviteToken = new URLSearchParams(new URL(expiredInvite).hash.slice(1)).get('token')!
  const inviteHash = createHash('sha256').update(inviteToken).digest('hex')
  expect(sql(`UPDATE invite SET expires_at=now()-interval '1 minute' WHERE token_hash='${inviteHash}' RETURNING id`)).toMatch(/[0-9a-f-]{36}/)
  const fresh = await browser.newContext({ baseURL })
  try {
    const visitor = await fresh.newPage()
    for (const link of [original, resent, expiredInvite]) {
      await visitor.goto(link)
      await expect(visitor.getByRole('heading', { name: 'Link expired' })).toBeVisible()
    }
    await visitor.goto(used)
    await visitor.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(visitor.getByRole('heading', { name: 'Link expired' })).toBeVisible()
    const expired = await requestSignIn(visitor, `expired-${suffix}@example.test`)
    const token = new URLSearchParams(new URL(expired).hash.slice(1)).get('token')!
    const hash = createHash('sha256').update(token).digest('hex')
    expect(sql(`UPDATE login_token SET expires_at=now()-interval '1 minute' WHERE token_hash='${hash}' RETURNING id`)).toMatch(/[0-9a-f-]{36}/)
    await visitor.goto(expired)
    await visitor.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(visitor.getByRole('heading', { name: 'Link expired' })).toBeVisible()
    expect((await visitor.request.get('/api/v1/me')).status()).toBe(401)
  } finally { await fresh.close() }
})

test('owner-verified GitHub setup discovers evidence, retries sync, removes and reconnects repositories', async ({ page }) => {
  test.setTimeout(180000)
  const suffix = unique()
  const slug = `github-${suffix}`
  await control(page.request, { installationID: 99, repositoryPresent: true, failListing: false, suspended: false, deleted: false, readOnly: false })
  await signup(page, `github-${suffix}@example.test`)
  await createOrganisation(page, slug, 'GitHub organisation')
  await page.goto(`/w/${slug}/admin`)
  const authorizations: URL[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/authorize') authorizations.push(url)
  })
  // A guessed installation ID and state cannot bind this organisation.
  const spoof = await page.request.get('/api/v1/github/setup?installation_id=99&state=spoofed', { maxRedirects: 0 })
  expect(spoof.status()).toBe(410)
  expect((await page.request.get(`/api/v1/w/${slug}/github`).then((r) => r.json())).status).toBe('disconnected')

  // A valid local setup state also cannot authorize an inaccessible candidate.
  const setup = await page.request.get(`/api/v1/w/${slug}/github/connect`, { maxRedirects: 0 })
  expect(setup.status()).toBe(302)
  const state = new URL(setup.headers().location).searchParams.get('state')!
  await page.goto(`/api/v1/github/setup?installation_id=123&state=${state}`)
  await expect(page).toHaveURL(/\/auth\/recovery$/)
  await expect(page.getByRole('heading', { name: 'Could not connect GitHub' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Return to Velvet' })).toBeVisible()
  expect((await page.request.get(`/api/v1/w/${slug}/github`).then((r) => r.json())).status).toBe('disconnected')

  await control(page.request, { readOnly: true })
  await page.goto(`/w/${slug}/admin`)
  await page.getByRole('link', { name: 'Connect GitHub', exact: true }).click()
  await expect(page).toHaveURL(/\/auth\/recovery$/)
  await expect(page.getByRole('heading', { name: 'Could not connect GitHub' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Return to Velvet' })).toBeVisible()
  expect((await page.request.get(`/api/v1/w/${slug}/github`).then((r) => r.json())).status).toBe('disconnected')
  await control(page.request, { readOnly: false })
  await page.goto(`/w/${slug}/admin`)
  await page.getByRole('link', { name: 'Connect GitHub', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/admin$`))
  await expect(page.getByText('Connected to runtime-github-user.')).toBeVisible({ timeout: 30000 })
  await expect(page.getByRole('link', { name: 'runtime-github-user/runtime-repo' })).toBeVisible()
  expect(authorizations).toHaveLength(3)
  expect(new Set(authorizations.map((url) => url.searchParams.get('state'))).size).toBe(3)
  for (const url of authorizations) {
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  }
  const { repos } = await page.request.get(`/api/v1/w/${slug}/repos`).then((r) => r.json())
  expect(repos).toHaveLength(1)
  const repo = repos[0]
  expect(repo.github_id).toBe(90099)
  await page.getByText('Disconnect GitHub', { exact: true }).click()
  await expect(page.getByText(/To disconnect, uninstall the App in the GitHub account/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open GitHub App settings' })).toHaveAttribute('href', 'https://github.com/settings/installations')
  // Everything below uses the repository discovered above; never reseed it.
  const issueResponse = await page.request.post(`/api/v1/w/${slug}/issues`, {
    headers: { Origin: new URL(page.url()).origin, 'Content-Type': 'application/json' }, data: { title: 'Evidence from installed repository' },
  })
  expect(issueResponse.status()).toBe(201)
  const issue = await issueResponse.json()
  const payload = {
    action: 'opened', installation: { id: 99 }, number: 71,
    repository: { id: repo.github_id, name: repo.name, owner: { login: repo.owner } },
    pull_request: { number: 71, title: 'Installed repository proof', state: 'open', draft: false, body: '', additions: 12, deletions: 2,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/71`, user: { login: repo.owner }, head: { ref: `feature/${issue.key.toLowerCase()}-proof` },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), merged_at: null },
  }
  await deliver(page.request, 'pull_request', payload)
  await page.goto(`/w/${slug}/issues/${issue.key}`)
  await expect(page.getByRole('link', { name: '#71', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Status' })).toHaveAttribute(
    'data-current-status',
    'backlog',
  )

  await control(page.request, { failListing: true })
  await page.goto(`/w/${slug}/admin`)
  await page.getByRole('button', { name: 'Retry sync', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Repository synchronization failed' })).toBeVisible({ timeout: 60000 })
  await control(page.request, { failListing: false })
  await page.getByRole('button', { name: 'Retry sync', exact: true }).click()
  await expect(page.getByText('Connected to runtime-github-user.')).toBeVisible({ timeout: 30000 })
  await expect(page.getByRole('alert')).toHaveCount(0)

  await control(page.request, { repositoryPresent: false })
  await deliver(page.request, 'installation_repositories', { action: 'removed', installation: { id: 99, account: { login: repo.owner } }, repositories_removed: [{ id: repo.github_id }] })
  await expect.poll(() => sql(`SELECT disconnected_at IS NOT NULL FROM repo WHERE id='${repo.id}'`)).toBe('t')
  await page.reload()
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible()
  const removed = await page.request.get(`/api/v1/w/${slug}/repos`).then((r) => r.json())
  expect(removed.repos[0].id).toBe(repo.id)
  expect(removed.repos[0].disconnected_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  await page.goto(`/w/${slug}/issues/${issue.key}`)
  await expect(page.getByRole('link', { name: '#71', exact: true }).first()).toBeVisible()

  await control(page.request, { deleted: true })
  await deliver(page.request, 'installation', { action: 'deleted', installation: { id: 99, account: { login: repo.owner } } })
  await page.goto(`/w/${slug}/admin`)
  await expect(page.getByRole('link', { name: 'Connect GitHub', exact: true })).toBeVisible()
  await control(page.request, { installationID: 100, deleted: false, repositoryPresent: true })
  await page.getByRole('link', { name: 'Connect GitHub', exact: true }).click()
  await expect(page.getByText('Connected to runtime-github-user.')).toBeVisible({ timeout: 30000 })
  const reconnected = await page.request.get(`/api/v1/w/${slug}/repos`).then((r) => r.json())
  expect(reconnected.repos[0].id).toBe(repo.id)
  expect(reconnected.repos[0].installation_id).toBe(100)
  expect(reconnected.repos[0].disconnected_at).toBeNull()
  await expect(page.getByText('Disconnected', { exact: true })).toHaveCount(0)
  await deliver(page.request, 'pull_request', { ...payload, pull_request: { ...payload.pull_request, title: 'Stale installation must not overwrite' } })
  await page.goto(`/w/${slug}/issues/${issue.key}`)
  await expect(page.getByText('Installed repository proof').first()).toBeVisible()
  await expect(page.getByText('Stale installation must not overwrite')).toHaveCount(0)
})
