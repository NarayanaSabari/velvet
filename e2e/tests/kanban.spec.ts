import { test, expect, type Page } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from './fixtures'

/**
 * The sprint board on the real stack: a person drags a card, the status is
 * saved, Undo puts it back, the keyboard path works, and a viewer cannot move
 * anything. Runs on a throwaway organisation so shared `lab` data is untouched.
 */
const id = randomBytes(4).toString('hex')
const slug = `kanban-${id}`
const email = `kanban.${id}@example.test`
const viewerEmail = `kanban-viewer.${id}@example.test`
const session = `kanban-${id}`
const viewerSession = `kanban-viewer-${id}`
let sprintId = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  sql(`
    INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Kanban', '${slug}', 'KAN');
    INSERT INTO app_user (email, name) VALUES ('${email}', 'Kim Kanban'), ('${viewerEmail}', 'Vic Viewer');
    INSERT INTO membership (workspace_id, user_id, role)
      SELECT w.id, u.id, CASE WHEN u.email = '${email}' THEN 'member'::membership_role ELSE 'viewer'::membership_role END
      FROM workspace w, app_user u WHERE w.slug = '${slug}' AND u.email IN ('${email}', '${viewerEmail}');
    INSERT INTO session (id, user_id, expires_at)
      SELECT '${hash(session)}', id, now() + interval '1 hour' FROM app_user WHERE email = '${email}';
    INSERT INTO session (id, user_id, expires_at)
      SELECT '${hash(viewerSession)}', id, now() + interval '1 hour' FROM app_user WHERE email = '${viewerEmail}';
    INSERT INTO project (workspace_id, key, name) SELECT id, 'web', 'Web app' FROM workspace WHERE slug = '${slug}';
    INSERT INTO sprint (workspace_id, project_id, name, starts_on, ends_on, state)
      SELECT p.workspace_id, p.id, 'Board sprint', '2026-10-01', '2026-10-31', 'active'
      FROM project p JOIN workspace w ON w.id = p.workspace_id WHERE w.slug = '${slug}';
    INSERT INTO milestone (workspace_id, sprint_id, name, position)
      SELECT workspace_id, id, 'Sign-in', 'a' FROM sprint WHERE workspace_id = (SELECT id FROM workspace WHERE slug = '${slug}');
    INSERT INTO issue (workspace_id, key, number, title, status, position, milestone_id, project_id)
      SELECT m.workspace_id, v.key, v.n, v.title, v.status::issue_status, v.pos, m.id, s.project_id
      FROM milestone m JOIN sprint s ON s.id = m.sprint_id,
        (VALUES
          ('KAN-1', 1, 'Rate-limit login links per source address', 'todo', 'a'),
          ('KAN-2', 2, 'Keep the sign-in error visible after submitting with a deliberately long title that must wrap inside its card', 'in_progress', 'b'),
          ('KAN-3', 3, 'Explain why the agent key disappears', 'backlog', 'c'),
          ('KAN-4', 4, 'Isolate identities', 'done', 'd'),
          ('KAN-5', 5, 'Retired idea', 'cancelled', 'e')
        ) AS v(key, n, title, status, pos)
      WHERE m.workspace_id = (SELECT id FROM workspace WHERE slug = '${slug}');
  `)
  sprintId = sql(`SELECT id FROM sprint WHERE workspace_id = (SELECT id FROM workspace WHERE slug = '${slug}')`)
})

test.afterAll(() => {
  sql(`
    DELETE FROM workspace WHERE slug = '${slug}';
    DELETE FROM app_user WHERE email IN ('${email}', '${viewerEmail}');
  `)
})

async function signIn(page: Page, baseURL: string, value: string) {
  await page.context().clearCookies()
  await page.context().addCookies([{ name: 'ticket_session', value, url: baseURL }])
}

const storedStatus = (key: string) =>
  sql(`SELECT status FROM issue WHERE key = '${key}' AND workspace_id = (SELECT id FROM workspace WHERE slug = '${slug}')`)

test('dragging a card saves its status, and Undo puts it back', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, session)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/w/${slug}/sprints/${sprintId}`)
  await page.getByRole('group', { name: 'Issue view' }).getByRole('button', { name: 'Board' }).click()
  await expect(page).toHaveURL(/[?&]view=board/)

  const board = page.getByTestId('sprint-kanban')
  await expect(board.getByRole('heading', { level: 3 })).toHaveText([/Backlog\s*1/, /Todo\s*1/, /In progress\s*1/, /In review\s*0/, /Done\s*1/])
  await expect(page.getByTestId('kanban-cancelled')).toContainText('Cancelled · 1')

  const saved = page.waitForResponse((response) =>
    response.url().endsWith(`/w/${slug}/issues/KAN-1`) && response.request().method() === 'PATCH')
  await page.getByTestId('kanban-card-KAN-1').dragTo(page.getByTestId('kanban-column-in_review'))
  expect((await saved).status()).toBe(200)
  await expect(page.getByTestId('kanban-column-in_review').getByTestId('kanban-card-KAN-1')).toBeVisible()
  await expect(page.getByTestId('kanban-toast')).toContainText('Moved KAN-1 to In review')
  expect(storedStatus('KAN-1')).toBe('in_review')

  // The board survives a reload because the view lives in the URL.
  await page.reload()
  await expect(page.getByTestId('kanban-column-in_review').getByTestId('kanban-card-KAN-1')).toBeVisible()
  await page.getByTestId('kanban-card-KAN-1').dragTo(page.getByTestId('kanban-column-done'))
  await expect(page.getByTestId('kanban-toast')).toContainText('Moved KAN-1 to Done')

  const undone = page.waitForResponse((response) =>
    response.url().endsWith(`/w/${slug}/issues/KAN-1`) && response.request().method() === 'PATCH')
  await page.getByTestId('kanban-toast').getByRole('button', { name: 'Undo' }).click()
  expect((await undone).status()).toBe(200)
  await expect(page.getByTestId('kanban-column-in_review').getByTestId('kanban-card-KAN-1')).toBeVisible()
  expect(storedStatus('KAN-1')).toBe('in_review')
})

test('a card moves from the keyboard alone, with a visible focus ring', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, session)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/w/${slug}/sprints/${sprintId}?view=board`)

  const trigger = page.getByTestId('kanban-card-KAN-3').getByRole('button', { name: 'Status' })
  await trigger.focus()
  await expect(trigger).toBeFocused()
  expect(await trigger.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('kanban-column-todo').getByTestId('kanban-card-KAN-3')).toBeVisible()
  await expect.poll(() => storedStatus('KAN-3')).toBe('todo')
})

test('the board fits desktop in both schemes, and phones keep the list', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, session)
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/w/${slug}/sprints/${sprintId}?view=board`)
    await expect(page.getByTestId('sprint-kanban')).toBeVisible()
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `test-results/kanban-1280-${colorScheme}.png`, fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('sprint-kanban')).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Issue view' })).toHaveCount(0)
    await expect(page.getByRole('listbox', { name: 'Todo issues' })).toBeVisible()
    expect(await overflow()).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `test-results/kanban-390-${colorScheme}.png`, fullPage: true })
  }
})

test('a viewer sees the board but cannot move cards', async ({ page, baseURL }) => {
  await signIn(page, baseURL!, viewerSession)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/w/${slug}/sprints/${sprintId}?view=board`)

  const card = page.getByTestId('kanban-card-KAN-2')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('draggable', 'false')
  await expect(card.getByRole('button', { name: 'Status' })).toHaveCount(0)
})
