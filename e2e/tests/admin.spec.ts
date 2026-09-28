import { test, expect, type Page } from '@playwright/test'
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

/** Opens a page from the Administration section list, as a person would. */
async function openSection(page: Page, name: string | RegExp, heading: string, path: string) {
  await page.getByRole('navigation', { name: 'Administration sections' }).getByRole('link', { name }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/admin/${path}$`))
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  await expect(page).toHaveTitle(`${heading} · Administration · Velvet`)
}

test('each Administration section is its own page, reached from the section list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/w/${slug}/admin`)
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/admin/general$`))
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible()

  const nav = page.getByRole('navigation', { name: 'Administration sections' })
  await expect(nav.getByRole('link', { name: /Members\s*2/ })).toBeVisible()
  await expect(nav.getByRole('link', { name: /Repositories\s*1/ })).toBeVisible()

  // Each link swaps the page, rather than scrolling one long page to a section.
  await openSection(page, /Members/, 'Members', 'members')
  await expect(page.getByLabel('Organisation name')).toHaveCount(0)
  await expect(nav.getByRole('link', { name: /Members/ })).toHaveAttribute('aria-current', 'page')
  await openSection(page, /Invitations/, 'Invitations', 'invitations')
  await expect(page.getByLabel('Role for Milo Member')).toHaveCount(0)
  await openSection(page, /Repositories/, 'Repositories', 'repositories')
  await openSection(page, 'Danger zone', 'Danger zone', 'danger')
  await expect(page.getByLabel(`Type ${slug} to confirm deletion`)).toBeVisible()
  await openSection(page, 'General', 'General', 'general')

  // Back returns to the previous page, and a page's address opens it directly.
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Danger zone' })).toBeVisible()
  await page.goto(`/w/${slug}/admin/members`)
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible()

  // An unknown page is not found rather than an empty Administration page.
  await page.goto(`/w/${slug}/admin/billing`)
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
})

test('an admin protects the last admin, maps a repository, and invites someone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  // The only admin cannot remove themselves, and is told why.
  await page.goto(`/w/${slug}/admin/members`)
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
  await openSection(page, /Repositories/, 'Repositories', 'repositories')
  await expect(page.getByText('Connected to admin-ux-org.')).toBeVisible()
  const mapping = page.getByLabel('Project for admin-ux-org/site')
  await expect(mapping).toHaveValue('')
  await mapping.selectOption({ label: 'Marketing site' })
  await expect.poll(() => sql(`SELECT p.key FROM repo r JOIN project p ON p.id = r.project_id WHERE r.github_id = ${repoGithubId}`)).toBe('site')
  await page.reload()
  await expect(page.getByLabel('Project for admin-ux-org/site').locator('option:checked')).toHaveText('Marketing site')

  // An invitation is confirmed, shows when it expires, and updates the count.
  await openSection(page, /Invitations/, 'Invitations', 'invitations')
  await page.getByLabel('Invite email', { exact: true }).fill(`invitee.${id}@example.test`)
  await page.getByRole('button', { name: 'Send invite', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: `Invitation sent to invitee.${id}@example.test.` })).toBeVisible()
  await expect(page.getByText('Expires in 7 days')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Administration sections' }).getByRole('link', { name: /Invitations\s*1/ })).toBeVisible()
})

test('Administration pages fit a phone and keep every action reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  for (const [path, heading] of [['general', 'General'], ['members', 'Members'], ['invitations', 'Invitations'], ['repositories', 'Repositories'], ['danger', 'Danger zone']]) {
    await page.goto(`/w/${slug}/admin/${path}`)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(await overflow(), `${heading} overflowed at 390px`).toBeLessThanOrEqual(0)
  }

  // The section list stays usable on a phone and moves between pages.
  await page.goto(`/w/${slug}/admin/members`)
  const remove = await page.getByRole('button', { name: 'Remove Milo Member' }).boundingBox()
  expect(remove!.height, 'Remove is a comfortable touch target').toBeGreaterThanOrEqual(40)
  await page.getByRole('navigation', { name: 'Administration sections' }).getByRole('link', { name: 'Danger zone' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/admin/danger$`))
  await page.screenshot({ path: 'test-results/admin-danger-390.png', fullPage: true })
})
