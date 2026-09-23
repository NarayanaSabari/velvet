import { test, expect, seededSessionToken, sql } from './fixtures'

const inviteEmail = 'ui-safety-invite@example.test'
const memberEmail = 'ui-safety-member@example.test'

function documentOverflows(page: import('@playwright/test').Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  seededSessionToken()
  sql(`
    DELETE FROM invite WHERE email = '${inviteEmail}';
    DELETE FROM app_user WHERE email = '${memberEmail}';

    INSERT INTO app_user (email, name)
    VALUES ('${memberEmail}', 'Safety Member');

    INSERT INTO membership (workspace_id, user_id, role)
    SELECT w.id, u.id, 'member'
    FROM workspace w, app_user u
    WHERE w.slug = 'lab' AND u.email = '${memberEmail}';

    INSERT INTO invite (workspace_id, email, role, token_hash, invited_by, expires_at)
    SELECT w.id, '${inviteEmail}', 'viewer', 'ui-safety-invite-token-hash', u.id, now() + interval '2 days'
    FROM workspace w, app_user u
    WHERE w.slug = 'lab' AND u.github_id = 1;
  `)
})

test.afterAll(() => {
  sql(`
    DELETE FROM invite WHERE email = '${inviteEmail}';
    DELETE FROM app_user WHERE email = '${memberEmail}';
  `)
})

test('destructive account and administration actions explain consequences inline', async ({ signedIn: page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/w/lab/admin')
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible()

  await page.getByRole('button', { name: `Revoke invitation to ${inviteEmail}` }).click()
  await expect(page.getByText(/will no longer be able to join this organisation/i)).toBeVisible()
  expect(sql(`SELECT count(*) FROM invite WHERE email = '${inviteEmail}' AND revoked_at IS NULL`)).toBe('1')
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: `Revoke invitation to ${inviteEmail}` }).click()
  await expect(page.getByRole('button', { name: 'Confirm revoke invitation' })).toBeVisible()
  expect(await documentOverflows(page)).toBe(false)
  await page.getByRole('button', { name: 'Confirm revoke invitation' }).click()
  await expect(page.getByText(inviteEmail)).toHaveCount(0)
  expect(sql(`SELECT count(*) FROM invite WHERE email = '${inviteEmail}' AND revoked_at IS NULL`)).toBe('0')

  await page.getByRole('button', { name: 'Remove Safety Member' }).click()
  await expect(page.getByText(/will lose access to this organisation/i)).toBeVisible()
  expect(await documentOverflows(page)).toBe(false)
  expect(sql(`SELECT count(*) FROM membership m JOIN app_user u ON u.id = m.user_id WHERE u.email = '${memberEmail}'`)).toBe('1')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Remove Safety Member' }).click()
  await page.getByRole('button', { name: 'Confirm removal' }).click()
  await expect(page.getByText('Safety Member')).toHaveCount(0)
  expect(sql(`SELECT count(*) FROM membership m JOIN app_user u ON u.id = m.user_id WHERE u.email = '${memberEmail}'`)).toBe('0')

  await page.goto('/w/lab/settings/profile')
  await expect(page.getByRole('heading', { level: 1, name: 'Profile', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Unlink GitHub profile' }).click()
  await expect(page.getByText(/future GitHub activity will not be attributed/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm unlink GitHub profile' })).toBeVisible()
  expect(await documentOverflows(page)).toBe(false)
  expect(sql(`SELECT github_login FROM app_user WHERE github_id = 1`)).toBe('sabari')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('button', { name: 'Unlink GitHub profile' })).toBeVisible()
})
