import { test, expect } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from './fixtures'

/**
 * Administration as an admin uses it, on its own throwaway organisation so the
 * shared `lab` data other specs depend on is never touched.
 */
const id = randomBytes(4).toString('hex')
const slug = `admin-ux-${id}`
const adminEmail = `admin-ux.${id}@example.test`
const memberEmail = `admin-ux-member.${id}@example.test`
const session = `admin-ux-${id}`
const githubInstallation = 880000 + Number.parseInt(id.slice(0, 4), 16)
const repoGithubId = 8800000 + Number.parseInt(id.slice(0, 5), 16)

test.beforeAll(() => {
  sql(`
    INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Admin UX', '${slug}', 'AUX');
    INSERT INTO app_user (email, name) VALUES ('${adminEmail}', 'Ada Admin'), ('${memberEmail}', 'Milo Member');
    INSERT INTO membership (workspace_id, user_id, role)
      SELECT w.id, u.id, CASE WHEN u.email = '${adminEmail}' THEN 'admin'::membership_role ELSE 'member'::membership_role END
      FROM workspace w, app_user u WHERE w.slug = '${slug}' AND u.email IN ('${adminEmail}', '${memberEmail}');
    INSERT INTO session (id, user_id, expires_at)
      SELECT '${createHash('sha256').update(session).digest('hex')}', id, now() + interval '1 hour' FROM app_user WHERE email = '${adminEmail}';
    INSERT INTO project (workspace_id, key, name) SELECT id, 'site', 'Marketing site' FROM workspace WHERE slug = '${slug}';
    INSERT INTO github_installation (id, account_login, workspace_id, ownership_verified_at, repos_synced_at)
      SELECT ${githubInstallation}, 'admin-ux-org', id, now(), now() FROM workspace WHERE slug = '${slug}';
    INSERT INTO repo (workspace_id, installation_id, github_id, owner, name, synced_at)
      SELECT id, ${githubInstallation}, ${repoGithubId}, 'admin-ux-org', 'site', now() FROM workspace WHERE slug = '${slug}';
  `)
})

test.afterAll(() => {
  sql(`
    DELETE FROM workspace WHERE slug = '${slug}';
    DELETE FROM github_installation WHERE id = ${githubInstallation};
    DELETE FROM app_user WHERE email IN ('${adminEmail}', '${memberEmail}');
  `)
})

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'ticket_session', value: session, url: baseURL! }])
})

test('an admin scans the organisation, protects the last admin, and maps a repository to a project', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/w/${slug}/admin`)
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible()

  // The section links show the organisation's shape and jump to each section.
  const nav = page.getByRole('navigation', { name: 'Administration sections' })
  await expect(nav.getByRole('link', { name: /Members\s*2/ })).toBeVisible()
  await expect(nav.getByRole('link', { name: /Repositories\s*1/ })).toBeVisible()
  await nav.getByRole('link', { name: 'Danger zone' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/admin#danger-zone$`))
  await expect(page.getByRole('heading', { name: 'Delete organisation' })).toBeInViewport()

  // The only admin cannot remove themselves, and is told why.
  const self = page.getByRole('button', { name: 'Leave organisation as Ada Admin' })
  await expect(self).toBeDisabled()
  await expect(page.getByText(/The only admin\. Make someone else an admin/)).toBeVisible()

  // Promoting a second admin lifts the guard.
  await page.getByLabel('Role for Milo Member').selectOption('admin')
  await expect(self).toBeEnabled()
  expect(sql(`SELECT m.role FROM membership m JOIN app_user u ON u.id = m.user_id WHERE u.email = '${memberEmail}'`)).toBe('admin')
  await page.getByLabel('Role for Milo Member').selectOption('member')
  await expect(self).toBeDisabled()

  // A repository is mapped to a project, which the API then reports.
  await expect(page.getByText('Connected to admin-ux-org.')).toBeVisible()
  const mapping = page.getByLabel('Project for admin-ux-org/site')
  await expect(mapping).toHaveValue('')
  await mapping.selectOption({ label: 'Marketing site' })
  await expect.poll(() => sql(`SELECT p.key FROM repo r JOIN project p ON p.id = r.project_id WHERE r.github_id = ${repoGithubId}`)).toBe('site')
  await page.reload()
  await expect(page.getByLabel('Project for admin-ux-org/site')).toHaveValue(/.+/)
  await expect(page.getByLabel('Project for admin-ux-org/site').locator('option:checked')).toHaveText('Marketing site')

  // An invitation is confirmed and shows when it expires.
  await page.getByLabel('Invite email', { exact: true }).fill(`invitee.${id}@example.test`)
  await page.getByRole('button', { name: 'Send invite', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: `Invitation sent to invitee.${id}@example.test.` })).toBeVisible()
  await expect(page.getByText('Expires in 7 days')).toBeVisible()
})

test('Administration fits a phone and keeps every action reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${slug}/admin`)
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible()
  await expect(page.getByLabel('Project for admin-ux-org/site')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  for (const name of ['Remove Milo Member', `Revoke invitation to invitee.${id}@example.test`]) {
    const box = await page.getByRole('button', { name }).boundingBox()
    if (box) expect(box.height, `${name} is a comfortable touch target`).toBeGreaterThanOrEqual(40)
  }
  await page.screenshot({ path: 'test-results/admin-390.png', fullPage: true })
})
