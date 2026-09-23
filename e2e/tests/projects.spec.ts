import { test, expect, resetWorkspaceData, seedWorkspace, seededSessionToken, sql } from './fixtures'
import { createHash } from 'node:crypto'

/**
 * Projects and the cross-organisation work log, driven in a real browser
 * against the real stack.
 *
 * These cover what a unit test cannot: that the routes exist, that the shell
 * reaches them, that the work log genuinely spans organisations, and that
 * neither page overflows at the two viewports this repository checks.
 */

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  resetWorkspaceData()
  // A second organisation, so the work log has more than one to gather from.
  seedWorkspace(seededSessionToken(), 'client')
  sql(`UPDATE workspace SET name = 'Client' WHERE slug = 'client'`)
})

test.afterAll(() => {
  // resetWorkspaceData deliberately leaves workspaces and memberships alone,
  // so a spec that adds one must remove it. A second membership turns the
  // shell's workspace name into a switcher, which changes what later specs
  // see on every page.
  sql(`DELETE FROM workspace WHERE slug = 'client'`)
  sql(`DELETE FROM app_user WHERE email = 'viewer-projects@example.test'`)
  resetWorkspaceData()
})

async function documentOverflows(page: import('@playwright/test').Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
}

test('a project can be created, filed against, and archived', async ({ signedIn: page }) => {
  await page.goto('/w/lab/projects')
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

  // The empty state explains what a project is for rather than just saying none.
  await expect(page.getByText('No active projects')).toBeVisible()

  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill('Velvet worklog')
  await page.getByLabel('Project key').fill('velvet')
  await page.getByRole('button', { name: 'Create project' }).click()

  const row = page.getByTestId('project-row-velvet')
  await expect(row).toBeVisible()
  await expect(row.getByText('Velvet worklog')).toBeVisible()

  // File an issue under it, then confirm the count links to exactly those.
  await page.goto('/w/lab/issues')
  // The page header and the empty state both offer "New issue", so name the
  // header one rather than depending on whether any issue already exists.
  await page.locator('header').getByRole('button', { name: 'New issue' }).click()
  await page.getByLabel('Title').fill('Ship the recap')
  await page.getByRole('button', { name: 'Create issue' }).click()
  await expect(page.getByText('Ship the recap')).toBeVisible()

  // Scoped to the Lab organisation: a project key is unique per organisation,
  // not globally, so an unscoped lookup could match several.
  await sql(`
    UPDATE issue SET project_id = (
      SELECT p.id FROM project p JOIN workspace w ON w.id = p.workspace_id
      WHERE p.key = 'velvet' AND w.slug = 'lab')
    WHERE title = 'Ship the recap'
      AND workspace_id = (SELECT id FROM workspace WHERE slug = 'lab')`)

  await page.goto('/w/lab/projects')
  await expect(page.getByTestId('project-row-velvet').getByText('1 open')).toBeVisible()
  await page.getByTestId('project-row-velvet').getByRole('link', { name: '1 open' }).click()
  await expect(page).toHaveURL(/\/w\/lab\/issues\?project=velvet$/)
  await expect(page.getByTestId('issues-project-filter')).toHaveValue('velvet')
  await expect(page.getByText('Ship the recap')).toBeVisible()

  // Archiving hides it by default without deleting the work it holds.
  await page.goto('/w/lab/projects')
  await page.getByTestId('project-row-velvet').getByRole('button', { name: 'Archive' }).click()
  await expect(page.getByText('Archive Velvet worklog?')).toBeVisible()
  await expect(page.getByTestId('project-row-velvet')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Archive Velvet worklog?')).toHaveCount(0)
  await page.getByTestId('project-row-velvet').getByRole('button', { name: 'Archive' }).click()
  await page.getByRole('button', { name: 'Confirm archive Velvet worklog' }).click()
  await expect(page.getByText('No active projects')).toBeVisible()
  await page.getByLabel('Show archived').check()
  await expect(page.getByTestId('project-row-velvet')).toBeVisible()
  await page.getByTestId('project-row-velvet').getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByTestId('project-row-velvet').getByText('Archived')).toHaveCount(0)
})

test('viewers can read projects without being offered write actions', async ({ signedIn: page, baseURL }) => {
  const token = 'viewer-projects-session'
  const hashed = createHash('sha256').update(token).digest('hex')
  sql(`
    INSERT INTO app_user (email, name)
    VALUES ('viewer-projects@example.test', 'Project Viewer')
    ON CONFLICT DO NOTHING;

    UPDATE app_user SET name = 'Project Viewer'
    WHERE email = 'viewer-projects@example.test';

    INSERT INTO membership (workspace_id, user_id, role)
    SELECT w.id, u.id, 'viewer'
    FROM workspace w, app_user u
    WHERE w.slug = 'lab' AND u.email = 'viewer-projects@example.test'
    ON CONFLICT DO NOTHING;

    UPDATE membership SET role = 'viewer'
    WHERE workspace_id = (SELECT id FROM workspace WHERE slug = 'lab')
      AND user_id = (SELECT id FROM app_user WHERE email = 'viewer-projects@example.test');

    INSERT INTO session (id, user_id, expires_at)
    SELECT '${hashed}', id, now() + interval '2 hours'
    FROM app_user WHERE email = 'viewer-projects@example.test'
    ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at;
  `)

  await page.context().clearCookies()
  const url = new URL(baseURL!)
  await page.context().addCookies([
    { name: 'ticket_session', value: token, domain: url.hostname, path: '/' },
  ])
  await page.goto('/w/lab/projects')

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  await expect(page.getByTestId('project-row-velvet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0)
})

test('the issues page filters by project and by unfiled work', async ({ signedIn: page }) => {
  await sql(`
    INSERT INTO issue (workspace_id, key, number, title, status, position)
    SELECT id, 'ENG-900', 900, 'Unfiled work', 'todo', 'zz' FROM workspace WHERE slug = 'lab'
    ON CONFLICT DO NOTHING`)

  await page.goto('/w/lab/issues')
  await expect(page.getByText('Unfiled work')).toBeVisible()

  await page.getByTestId('issues-project-filter').selectOption('velvet')
  await expect(page.getByText('Ship the recap')).toBeVisible()
  await expect(page.getByText('Unfiled work')).toHaveCount(0)

  // Unfiled work must stay reachable: it is deliberately allowed to exist.
  await page.getByTestId('issues-project-filter').selectOption('unfiled')
  await expect(page.getByText('Unfiled work')).toBeVisible()
  await expect(page.getByText('Ship the recap')).toHaveCount(0)
})

test('the work log gathers work from every organisation', async ({ signedIn: page }) => {
  // Work in both organisations, written the way an agent writes it.
  await sql(`
    INSERT INTO comment (workspace_id, target_type, target_id, author_id, body, source, kind)
    SELECT w.id, 'project', p.id, u.id, 'I shipped the cross-organisation work log.', 'agent', 'progress'
    FROM workspace w
    JOIN project p ON p.workspace_id = w.id AND p.key = 'velvet'
    JOIN app_user u ON u.github_id = 1
    WHERE w.slug = 'lab'`)
  await sql(`
    INSERT INTO issue (workspace_id, key, number, title, status, position, assignee_id)
    SELECT w.id, 'CLI-1', 1, 'Client ticket', 'in_progress', 'a', u.id
    FROM workspace w, app_user u WHERE w.slug = 'client' AND u.github_id = 1
    ON CONFLICT DO NOTHING`)

  await page.goto('/w/lab')
  await page.getByRole('link', { name: 'My work log' }).first().click()
  await expect(page).toHaveURL(/\/me\/worklog$/)
  await expect(page.getByRole('heading', { name: 'Work log' })).toBeVisible()

  await expect(page.getByText('I shipped the cross-organisation work log.')).toBeVisible()
  await expect(page.getByText('Client ticket')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Lab', level: 3 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Client', level: 3 })).toBeVisible()

  // The Markdown form is what gets pasted into a message.
  await expect(page.getByRole('link', { name: 'Copy as Markdown' })).toHaveAttribute(
    'href',
    '/api/v1/me/worklog.md?days=7',
  )
})

test('projects and the work log fit both viewports without overflow', async ({ signedIn: page }) => {
  for (const path of ['/w/lab/projects', '/me/worklog']) {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport)
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      if (path === '/w/lab/projects') {
        await page.getByTestId('project-row-velvet').getByRole('button', { name: 'Archive' }).click()
        await expect(page.getByText('Archive Velvet worklog?')).toBeVisible()
      }
      expect(
        await documentOverflows(page),
        `${path} overflowed at ${viewport.width}x${viewport.height}`,
      ).toBe(false)
      if (path === '/w/lab/projects') {
        await page.getByRole('button', { name: 'Cancel' }).click()
      }
    }
  }
})
