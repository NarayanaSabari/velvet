import { test, expect, seededSessionToken, sql } from './fixtures'

const inviteEmail = 'ui-safety-invite@example.test'
const memberEmail = 'ui-safety-member@example.test'
const accessibilityRunId = `${Date.now()}-${process.pid}`
const accessibilitySprintName = `Accessibility review ${accessibilityRunId}`
const accessibilityIssueTitle = `Verify accessible shell behavior ${accessibilityRunId}`
const contentIssueTitle = `Verify accessible content behavior ${accessibilityRunId}`

function documentOverflows(page: import('@playwright/test').Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  seededSessionToken()
  sql(`
    DELETE FROM activity
    WHERE target_id IN (
      SELECT c.id FROM comment c
      JOIN issue i ON c.target_type = 'issue' AND c.target_id = i.id
      WHERE i.title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
        AND i.workspace_id = (SELECT id FROM workspace WHERE slug = 'lab')
    ) OR target_id IN (
      SELECT i.id FROM issue i
      WHERE i.title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
        AND i.workspace_id = (SELECT id FROM workspace WHERE slug = 'lab')
    );
    DELETE FROM comment_mention
    WHERE comment_id IN (
      SELECT c.id FROM comment c
      JOIN issue i ON c.target_type = 'issue' AND c.target_id = i.id
      WHERE i.title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
        AND i.workspace_id = (SELECT id FROM workspace WHERE slug = 'lab')
    );
    DELETE FROM comment c USING issue i
    WHERE c.target_type = 'issue' AND c.target_id = i.id
      AND i.title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
      AND i.workspace_id = (SELECT id FROM workspace WHERE slug = 'lab');
    DELETE FROM issue
    WHERE title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
      AND workspace_id = (SELECT id FROM workspace WHERE slug = 'lab');
    DELETE FROM sprint
    WHERE name = '${accessibilitySprintName}'
      AND workspace_id = (SELECT id FROM workspace WHERE slug = 'lab');
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
    DELETE FROM activity
    WHERE target_id IN (
      SELECT c.id FROM comment c
      JOIN issue i ON c.target_type = 'issue' AND c.target_id = i.id
      WHERE i.title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
        AND i.workspace_id = (SELECT id FROM workspace WHERE slug = 'lab')
    ) OR target_id IN (
      SELECT i.id FROM issue i
      WHERE i.title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
        AND i.workspace_id = (SELECT id FROM workspace WHERE slug = 'lab')
    );
    DELETE FROM comment_mention
    WHERE comment_id IN (
      SELECT c.id FROM comment c
      JOIN issue i ON c.target_type = 'issue' AND c.target_id = i.id
      WHERE i.title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
        AND i.workspace_id = (SELECT id FROM workspace WHERE slug = 'lab')
    );
    DELETE FROM comment c USING issue i
    WHERE c.target_type = 'issue' AND c.target_id = i.id
      AND i.title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
      AND i.workspace_id = (SELECT id FROM workspace WHERE slug = 'lab');
    DELETE FROM issue
    WHERE title IN ('${accessibilityIssueTitle}', '${contentIssueTitle}')
      AND workspace_id = (SELECT id FROM workspace WHERE slug = 'lab');
    DELETE FROM sprint
    WHERE name = '${accessibilitySprintName}'
      AND workspace_id = (SELECT id FROM workspace WHERE slug = 'lab');
    DELETE FROM invite WHERE email = '${inviteEmail}';
    DELETE FROM app_user WHERE email = '${memberEmail}';
  `)
})

test('destructive account and administration actions explain consequences inline', async ({ signedIn: page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/w/lab/admin')
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible()

  let releaseResend!: () => void
  await page.route('**/api/v1/w/lab/invites/*/resend', async (route) => {
    await new Promise<void>((resolve) => { releaseResend = resolve })
    await route.continue()
  })
  await page.getByRole('button', { name: `Resend invitation to ${inviteEmail}` }).click()
  await expect(page.getByRole('button', { name: `Resending invitation to ${inviteEmail}…` })).toBeDisabled()
  releaseResend()
  await expect(page.getByRole('button', { name: `Resend invitation to ${inviteEmail}` })).toBeEnabled()
  await page.unroute('**/api/v1/w/lab/invites/*/resend')

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

  let releaseDelete!: () => void
  await page.route('**/api/v1/w/lab', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    await new Promise<void>((resolve) => { releaseDelete = resolve })
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: 'Deletion paused for this check' } }),
    })
  })
  await page.getByLabel('Type lab to confirm deletion').fill('lab')
  await page.getByRole('button', { name: 'Delete organisation' }).click()
  await expect(page.getByRole('button', { name: 'Deleting organisation…' })).toBeDisabled()
  releaseDelete()
  await expect(page.getByRole('alert')).toHaveText('Deletion paused for this check')
  await expect(page.getByLabel('Type lab to confirm deletion')).toHaveValue('lab')
  await page.unroute('**/api/v1/w/lab')

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

test('the product shell supports keyboard menus, skip navigation, titles, and one main landmark', async ({ signedIn: page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/w/lab')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await expect(page).toHaveTitle('Dashboard · Velvet')

  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main#main-content')).toBeFocused()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const accountTrigger = page.getByRole('button', { name: 'Open account menu' })
  await accountTrigger.click()
  const accountMenu = page.getByRole('menu')
  await expect(accountMenu.getByRole('menuitem', { name: 'Profile' })).toBeFocused()
  await expect(accountMenu).toHaveCSS('transition-duration', '0s')
  await page.keyboard.press('ArrowDown')
  await expect(accountMenu.getByRole('menuitem', { name: 'New organisation' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(accountTrigger).toBeFocused()
  await expect(accountTrigger).toHaveAttribute('aria-expanded', 'false')

  await accountTrigger.click()
  await page.getByRole('heading', { level: 1, name: 'Dashboard' }).click()
  await expect(accountTrigger).toHaveAttribute('aria-expanded', 'false')

  await accountTrigger.click()
  const leaveOrganisation = accountMenu.getByRole('menuitem', { name: 'Leave organisation' })
  await leaveOrganisation.focus()
  await page.keyboard.press('Enter')
  const leaveDialog = page.getByRole('alertdialog', { name: 'Leave lab' })
  await expect(leaveDialog.getByRole('button', { name: 'Confirm leave' })).toBeFocused()
  let releaseLeave!: () => void
  await page.route('**/api/v1/w/lab/leave', async (route) => {
    await new Promise<void>((resolve) => { releaseLeave = resolve })
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: 'Leaving paused for this check' } }),
    })
  })
  await leaveDialog.getByRole('button', { name: 'Confirm leave' }).click()
  await expect(leaveDialog.getByRole('button', { name: 'Leaving organisation…' })).toBeDisabled()
  releaseLeave()
  await expect(leaveDialog.getByRole('alert')).toHaveText('Leaving paused for this check')
  await leaveDialog.getByRole('button', { name: 'Cancel' }).click()
  await page.unroute('**/api/v1/w/lab/leave')
  await expect(accountMenu.getByRole('menuitem', { name: 'Leave organisation' })).toBeFocused()
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/w/lab/issues')
  await expect(page).toHaveTitle('Issues · Velvet')
  const moreTrigger = page.getByRole('button', { name: 'More' })
  await moreTrigger.click()
  const moreMenu = page.getByRole('menu')
  await expect(moreMenu.getByRole('menuitem', { name: 'Team feed' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(moreTrigger).toBeFocused()
  await expect(moreTrigger).toHaveAttribute('aria-expanded', 'false')

  const sprint = await request.post('/api/v1/w/lab/sprints', {
    data: { name: accessibilitySprintName, starts_on: '2026-11-01', ends_on: '2026-11-30' },
  }).then((response) => response.json())
  const milestone = await request.post(`/api/v1/w/lab/sprints/${sprint.id}/milestones`, {
    data: { name: 'Keyboard shell review' },
  }).then((response) => response.json())
  const issue = await request.post('/api/v1/w/lab/issues', {
    data: { title: accessibilityIssueTitle, milestone_id: milestone.id },
  }).then((response) => response.json())

  await page.goto(`/w/lab/milestones/${milestone.id}`)
  await expect(page).toHaveTitle('Keyboard shell review · Velvet')
  await expect(page.locator('main')).toHaveCount(1)

  await page.goto(`/w/lab/sprints/${sprint.id}`)
  await expect(page).toHaveTitle(`${accessibilitySprintName} · Velvet`)
  const listbox = page.getByRole('listbox', { name: /issues/i })
  await expect(listbox.locator('[role="option"] a')).toHaveCount(0)
  await listbox.focus()
  await expect(listbox).toBeFocused()
  expect(await listbox.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')

  await page.goto(`/w/lab/issues/${issue.key}`)
  await expect(page).toHaveTitle(`${issue.key} ${accessibilityIssueTitle} · Velvet`)
  await expect(page.locator('main')).toHaveCount(1)
  expect(await documentOverflows(page)).toBe(false)
})

test('Markdown stays readable and mentions provide keyboard navigation to their target', async ({
  signedIn: page,
  request,
}) => {
  const description = [
    '## Release checklist',
    '',
    'Use the deployment runbook before release.',
    '',
    '- [x] Complete migration',
    '- [ ] Verify rollback',
    '  - [x] Document fallback',
    '',
    '```go',
    'func main() {}',
    '```',
  ].join('\n')
  const issueResponse = await request.post('/api/v1/w/lab/issues', {
    data: { title: contentIssueTitle, description },
  })
  expect(issueResponse.status()).toBe(201)
  const issue = await issueResponse.json()

  const commentResponse = await request.post(`/api/v1/w/lab/issues/${issue.key}/comments`, {
    data: { body: '@sabari Please review the release checklist.' },
  })
  expect(commentResponse.status()).toBe(201)

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/w/lab/issues/${issue.key}`)
  const markdown = page.locator('.markdown').first()
  const heading = markdown.getByRole('heading', { level: 2, name: 'Release checklist' })
  await expect(heading).toBeVisible()
  await expect(
    markdown.getByRole('checkbox', { name: 'Completed task: Complete migration' }),
  ).toBeChecked()
  await expect(
    markdown.getByRole('checkbox', { name: 'Incomplete task: Verify rollback' }),
  ).not.toBeChecked()
  await expect(
    markdown.getByRole('checkbox', { name: 'Completed task: Document fallback' }),
  ).toBeChecked()
  await expect(markdown.locator('pre')).toContainText('func main() {}')
  const [headingHeight, bodyHeight, codePadding] = await Promise.all([
    heading.evaluate((element) => element.getBoundingClientRect().height),
    markdown.getByText('Use the deployment runbook before release.').evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
    markdown.locator('pre').evaluate((element) => getComputedStyle(element).padding),
  ])
  expect(headingHeight).toBeGreaterThan(bodyHeight)
  expect(codePadding).not.toBe('0px')

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await documentOverflows(page)).toBe(false)

  await page.goto('/w/lab/mentions')
  const target = page.getByRole('link', { name: issue.key, exact: true })
  await expect(target).toBeVisible()
  await target.focus()
  await expect(target).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/w/lab/issues/${issue.key}$`))
  await expect(page.getByRole('heading', { level: 1, name: contentIssueTitle })).toBeVisible()
  expect(await documentOverflows(page)).toBe(false)
})
