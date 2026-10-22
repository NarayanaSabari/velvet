import { test, expect } from '@playwright/test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from './fixtures'

const id = randomBytes(4).toString('hex')
const slug = `manage-${id}`
const email = `manage.${id}@example.test`
const session = `manage-${id}`
const scratch = mkdtempSync(join(tmpdir(), 'velvet-manage-e2e-'))
const bin = join(scratch, 'velvet')
const repo = join(scratch, 'repo')
const home = join(scratch, 'config')
const cliEnv = { ...process.env, VELVET_NO_KEYCHAIN: '1', VELVET_TOKEN: '', HOME: home, XDG_CONFIG_HOME: home }
let account = ''

function velvet(args: string[]) {
  return spawnSync(bin, args, { cwd: repo, env: cliEnv, encoding: 'utf8' })
}

function token(kind: string) {
  const configDir = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : home
  const values = Object.values(JSON.parse(readFileSync(join(configDir, 'velvet', 'credentials.json'), 'utf8'))) as string[]
  const secrets = values.filter(value => kind === 'setup' ? value.startsWith('velvetsetup_') : value.startsWith('velvet_'))
  return secrets.find(value => sql(`SELECT kind FROM api_token WHERE token_hash='${createHash('sha256').update(kind === 'setup' ? `cli-setup:${value}` : value).digest('hex')}'`) === kind)!
}

test.beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url))
  execFileSync('go', ['build', '-o', bin, './cmd/velvet'], { cwd: resolve(here, '..', '..', 'cli'), stdio: 'inherit' })
  mkdirSync(repo)
  mkdirSync(home)
  sql(`
    INSERT INTO workspace (name, slug, issue_prefix) VALUES ('Management Org', '${slug}', 'MGT');
    INSERT INTO app_user (email, name) VALUES ('${email}', 'Management User');
    INSERT INTO membership (workspace_id,user_id,role)
      SELECT w.id,u.id,'admin' FROM workspace w,app_user u WHERE w.slug='${slug}' AND u.email='${email}';
    INSERT INTO session (id,user_id,expires_at)
      SELECT '${createHash('sha256').update(session).digest('hex')}',id,now()+interval '1 hour' FROM app_user WHERE email='${email}';
    INSERT INTO project (workspace_id,key,name)
      SELECT id,'web','Web' FROM workspace WHERE slug='${slug}';
  `)
  account = sql(`SELECT id FROM app_user WHERE email='${email}'`)
})

test.afterAll(() => {
  sql(`DELETE FROM workspace WHERE slug='${slug}'; DELETE FROM app_user WHERE email='${email}';`)
  rmSync(scratch, { recursive: true, force: true })
})

test('separate management consent keeps setup and repository authority isolated', async ({ page, context, request, baseURL }) => {
  test.setTimeout(90_000)
  await context.addCookies([{ name: 'ticket_session', value: session, url: baseURL! }])
  const approveCLI = async (args: string[], label: string, flow: string) => {
    const child = spawn(bin, [...args, '--server', baseURL!, '--no-browser'], { cwd: repo, env: cliEnv })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    const exited = new Promise<number | null>(done => child.on('exit', done))
    try {
      await expect.poll(() => output.match(/http\S+\/cli\/approve\?code=\S+/)?.[0], { timeout: 15_000 }).toBeTruthy()
      const url = output.match(/http\S+\/cli\/approve\?code=\S+/)![0]
      await page.goto(url)
      const code = new URL(url).searchParams.get('code')!
      const lookup = await request.get(`/api/v1/cli/sessions/${code}`, { headers: { Cookie: `ticket_session=${session}` } })
      expect((await lookup.json()).flow).toBe(flow)
      const button = page.getByRole('button', { name: label, exact: true })
      await expect(button).toBeVisible()
      expect(sql(`SELECT count(*) FROM cli_session WHERE user_code='${code.replace('-', '')}' AND status='pending'`)).toBe('1')
      await expect(page.getByLabel('Organisation', { exact: true })).toHaveCount(0)
      await expect(page.getByLabel('Project', { exact: true })).toHaveCount(0)
      if (flow === 'manage') {
        await expect(page.getByText(/account-wide management access/)).toContainText('limited by your current organisation memberships and roles')
        await expect(page.getByText(/account-wide management access/)).toContainText('separate from normal velvet login')
        for (const [width, height] of [[1280, 900], [390, 844]] as const) {
          for (const colorScheme of ['light', 'dark'] as const) {
            await page.setViewportSize({ width, height })
            await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
            await expect(button).toBeVisible()
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
            await page.screenshot({ path: `test-results/cli-manage-${width}-${colorScheme}.png`, fullPage: true })
          }
        }
      }
      for (let step = 0; step < 20; step++) {
        if (await button.evaluate(el => el === document.activeElement)) break
        await page.keyboard.press('Tab')
      }
      await expect(button).toBeFocused()
      expect(await button.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none')
      await page.keyboard.press('Enter')
      await expect(page.getByText('Connected.', { exact: true })).toBeVisible()
      expect(await exited, output).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill()
    }
  }
  await approveCLI(['login'], 'Approve login', 'login')
  expect(velvet(['whoami', '--server', baseURL!]).stdout).toContain('machine setup only')
  const setup = token('setup')
  expect(setup).toBeTruthy()
  expect(velvet(['admin', 'whoami', '--server', baseURL!]).status).not.toBe(0)
  await approveCLI(['admin', 'login'], 'Approve account management', 'manage')
  expect(velvet(['admin', 'whoami', '--server', baseURL!]).stdout).toContain('account-wide, subject to current organisation roles')
  expect(velvet(['whoami', '--server', baseURL!]).stdout).toContain('machine setup only')
  const personal = token('personal')
  expect(personal).toBeTruthy()
  const me = await request.get('/api/v1/me', { headers: { Authorization: `Bearer ${personal}` } })
  expect((await me.json()).token_kind).toBe('personal')
  const setupMe = await request.get('/api/v1/me', { headers: { Authorization: `Bearer ${setup}` } })
  expect((await setupMe.json()).token_kind).toBe('setup')
  const init = velvet(['init', '--server', baseURL!, '--organisation', slug, '--project', 'web', '--non-interactive'])
  expect(init.status, init.stderr).toBe(0)
  const project = token('project')
  const run = (args: string[]) => {
    const result = velvet(args)
    expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(0)
    return result.stdout
  }
  const key = run(['new', 'CLI parity ticket']).trim()
  run(['edit', key, '--title', 'CLI edited ticket', '--desc', 'Edited narrative', '--priority', '2', '--assignee', account])
  expect(run(['issue', key])).toContain('CLI edited ticket')
  expect(sql(`SELECT status FROM issue WHERE key='${key}' AND workspace_id=(SELECT id FROM workspace WHERE slug='${slug}')`)).toBe('backlog')
  run(['comments', key, 'add', '--kind', 'note', 'CLI comment'])
  const comments = JSON.parse(run(['comments', key, 'list'])).comments
  const commentID = comments.find((comment: { body: string }) => comment.body === 'CLI comment').id
  run(['comments', key, 'edit', commentID, 'CLI edited comment'])
  expect(run(['comments', key, 'list'])).toContain('CLI edited comment')
  expect(velvet(['comments', key, 'delete', commentID]).status).toBe(2)
  run(['comments', key, 'delete', commentID, '--yes'])
  expect(run(['comments', key, 'list'])).not.toContain('CLI edited comment')
  expect(JSON.parse(run(['evidence', key, 'list']))).toEqual({ pull_requests: [], reviews: [], commits: [] })
  run(['sprints', 'new', 'CLI sprint', '2026-10-01', '2026-10-31'])
  const sprint = sql(`SELECT id FROM sprint WHERE workspace_id=(SELECT id FROM workspace WHERE slug='${slug}')`)
  run(['sprint', sprint, 'edit', '--name', 'CLI edited sprint', '--ends-on', '2026-11-01'])
  expect(run(['sprint', sprint, 'show'])).toContain('CLI edited sprint')
  run(['milestones', 'new', sprint, 'First goal'])
  run(['milestones', 'new', sprint, 'Second goal'])
  const first = sql(`SELECT id FROM milestone WHERE sprint_id='${sprint}' AND name='First goal'`)
  const second = sql(`SELECT id FROM milestone WHERE sprint_id='${sprint}' AND name='Second goal'`)
  run(['milestone', first, 'edit', '--description', 'CLI goal narrative', '--after', second, '--owner', account])
  expect(sql(`SELECT owner_id FROM milestone WHERE id='${first}'`)).toBe(account)
  run(['milestone', first, 'edit', '--owner', 'none'])
  expect(sql(`SELECT owner_id IS NULL FROM milestone WHERE id='${first}'`)).toBe('t')
  run(['comments', '--milestone', first, 'add', 'Milestone CLI note'])
  expect(run(['comments', '--milestone', first, 'list'])).toContain('Milestone CLI note')
  expect(run(['milestone', first, 'show'])).toContain('CLI goal narrative')
  expect(sql(`SELECT a.position > b.position FROM milestone a,milestone b WHERE a.id='${first}' AND b.id='${second}'`)).toBe('t')
  expect(velvet(['sprint', sprint, 'activate']).status).toBe(2)
  run(['sprint', sprint, 'activate', '--yes'])
  run(['sprint', sprint, 'complete', '--yes'])
  expect(sql(`SELECT state FROM sprint WHERE id='${sprint}'`)).toBe('completed')
  const png = join(scratch, 'reference.png')
  writeFileSync(png, await page.screenshot())
  run(['upload-image', key, png, '--caption', 'CLI parity reference'])
  const images = JSON.parse(run(['images', key])).images
  expect(images).toHaveLength(1)
  expect(velvet(['image', images[0].id, 'delete']).status).toBe(2)
  run(['image', images[0].id, 'delete', '--yes'])
  expect(JSON.parse(run(['images', key])).images).toHaveLength(0)
  run(['comments', '--project', 'add', 'Scoped mention'])
  const mention = JSON.parse(run(['comments', '--project', 'list'])).comments[0].id
  sql(`INSERT INTO comment_mention(comment_id,user_id) VALUES ('${mention}','${account}')`)
  expect(run(['mentions', 'list', '--unread'])).toContain('Scoped mention')
  run(['mentions', 'read', mention])
  expect(run(['mentions', 'list', '--unread'])).not.toContain('Scoped mention')
  sql(`INSERT INTO project(workspace_id,key,name) SELECT id,'other','Other' FROM workspace WHERE slug='${slug}';
    INSERT INTO issue(workspace_id,key,number,title,position,created_by,project_id)
    SELECT w.id,'MGT-999',999,'Hidden other project','z','${account}',p.id FROM workspace w JOIN project p ON p.workspace_id=w.id WHERE w.slug='${slug}' AND p.key='other';
    INSERT INTO comment(workspace_id,target_type,target_id,author_id,body)
    SELECT workspace_id,'issue',id,'${account}','Hidden mention' FROM issue WHERE key='MGT-999' AND workspace_id=(SELECT id FROM workspace WHERE slug='${slug}');
    INSERT INTO comment_mention(comment_id,user_id) SELECT id,'${account}' FROM comment WHERE body='Hidden mention' AND workspace_id=(SELECT id FROM workspace WHERE slug='${slug}');
    UPDATE issue SET updated_at=now()-interval '30 days' WHERE key='MGT-999' AND workspace_id=(SELECT id FROM workspace WHERE slug='${slug}');
    UPDATE comment SET created_at=now()-interval '30 days' WHERE body='Hidden mention' AND workspace_id=(SELECT id FROM workspace WHERE slug='${slug}');`)
  expect(run(['mentions', 'list'])).not.toContain('Hidden mention')
  expect(run(['reports', 'stale', '--days', '1'])).not.toContain('Hidden other project')
  run(['reports', 'activity'])
  run(['reports', 'milestones'])
  run(['reports', 'closed'])
  const options = ['--server', baseURL!, '--account', account, '--organisation', slug]
  expect(run(['admin', 'reports', 'stale', '--days', '1', ...options])).toContain('Hidden other project')
  expect(run(['admin', 'mentions', 'list', ...options])).toContain('Hidden mention')
  run(['mentions', 'read', '--all', '--yes'])
  expect(run(['admin', 'mentions', 'list', '--unread', ...options])).toContain('Hidden mention')
  expect(velvet(['admin', 'organisation', 'update', '--name', 'Updated management', ...options]).status).toBe(0)
  for (const raw of [setup, project]) {
    const blocked = await request.patch(`/api/v1/w/${slug}`, { headers: { Authorization: `Bearer ${raw}` }, data: { name: 'Denied' } })
    expect(blocked.status()).toBe(403)
  }
  sql(`UPDATE membership SET role='member' WHERE user_id='${account}'`)
  expect(velvet(['admin', 'organisation', 'update', '--name', 'Denied', ...options]).status).not.toBe(0)
  sql(`UPDATE membership SET role='viewer' WHERE user_id='${account}'`)
  const denied = await request.post(`/api/v1/w/${slug}/issues`, { headers: { Authorization: `Bearer ${personal}` }, data: { title: 'Denied' } })
  expect(denied.status()).toBe(403)
  expect(velvet(['admin', 'logout', '--server', baseURL!, '--yes']).status).toBe(0)
  expect((await request.get('/api/v1/me', { headers: { Authorization: `Bearer ${personal}` } })).status()).toBe(401)
  expect((await request.get('/api/v1/me', { headers: { Authorization: `Bearer ${setup}` } })).status()).toBe(200)
  expect((await request.get('/api/v1/me', { headers: { Authorization: `Bearer ${project}` } })).status()).toBe(200)
  expect(velvet(['admin', 'whoami', '--server', baseURL!]).status).not.toBe(0)
})
