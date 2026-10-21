import { test, expect } from '@playwright/test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from './fixtures'
import { mailLink } from './onboarding-helpers'

/**
 * The velvet CLI end to end: browser login grants setup access, then terminal
 * init chooses one project and stores a separate project-scoped key. The
 * key must reach its own project and nothing else, whatever velvet.yaml says.
 *
 * Runs the real Go binary against the real stack, on a throwaway organisation
 * with two projects so the shared `lab` data other specs rely on is untouched.
 */
const id = randomBytes(4).toString('hex')
const slug = `cli-${id}`
const email = `cli.${id}@example.test`
const session = `cli-${id}`

const here = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'velvet-cli-e2e-'))
const bin = join(scratch, 'velvet')
const repo = join(scratch, 'repo')
const configHome = join(scratch, 'config')

// The CLI keeps keys in the OS keychain. Tests use the 0600 file fallback in
// a private directory so they never touch the person's real keychain.
const cliEnv = {
  ...process.env,
  VELVET_NO_KEYCHAIN: '1',
  VELVET_TOKEN: '',
  HOME: configHome,
  XDG_CONFIG_HOME: configHome,
}

function velvet(args: string[], input?: string) {
  const r = spawnSync(bin, args, { cwd: repo, env: cliEnv, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  execFileSync('go', ['build', '-o', bin, './cmd/velvet'], { cwd: resolve(here, '..', '..', 'cli'), stdio: 'inherit' })
  mkdirSync(repo, { recursive: true })
  mkdirSync(configHome, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  sql(`
    INSERT INTO workspace (name, slug, issue_prefix) VALUES ('CLI Org', '${slug}', 'CLI');
    INSERT INTO app_user (email, name) VALUES ('${email}', 'Cleo Cli');
    INSERT INTO membership (workspace_id, user_id, role)
      SELECT w.id, u.id, 'admin' FROM workspace w, app_user u WHERE w.slug = '${slug}' AND u.email = '${email}';
    INSERT INTO session (id, user_id, expires_at)
      SELECT '${createHash('sha256').update(session).digest('hex')}', id, now() + interval '1 hour' FROM app_user WHERE email = '${email}';
    INSERT INTO project (workspace_id, key, name)
      SELECT w.id, p.key, p.name FROM workspace w, (VALUES ('web', 'Web app'), ('api', 'Public API')) AS p(key, name)
      WHERE w.slug = '${slug}';
  `)
})

test.afterAll(() => {
  sql(`
    DELETE FROM workspace WHERE slug IN ('${slug}', '${slug}-created');
    DELETE FROM app_user WHERE email = '${email}';
  `)
  rmSync(scratch, { recursive: true, force: true })
})

test('install.sh installs a checksummed binary from this server', async ({ request, baseURL }) => {
  const dir = join(scratch, 'installed')
  const script = await (await request.get('/install.sh')).text()
  expect(script).toContain('SHA256SUMS')
  const r = spawnSync('sh', ['-s'], {
    input: script,
    env: { ...process.env, VELVET_SERVER: baseURL!, VELVET_INSTALL_DIR: dir },
    encoding: 'utf8',
  })
  expect(r.status, r.stderr).toBe(0)
  const version = spawnSync(join(dir, 'velvet'), ['--version'], { encoding: 'utf8' })
  expect(version.stdout).toMatch(/^velvet /)
  // The server publishes the version it serves, so a fresh install is current.
  const update = spawnSync(join(dir, 'velvet'), ['update', '--check', '--server', baseURL!], { encoding: 'utf8' })
  expect(update.status, update.stderr).toBe(0)
  expect(update.stdout).toContain('is up to date')

  // A missing binary is a 404, never the SPA's index.html saved as a program.
  expect((await request.get('/download/velvet-plan9-mips')).status()).toBe(404)
})

test('signed-out login consent returns after email sign-in in a fresh tab', async ({ page, context, request, baseURL }) => {
  const started = await request.post('/api/v1/cli/sessions', { data: { client_name: 'E2E return path', flow: 'login' } })
  expect(started.ok(), await started.text()).toBe(true)
  const device = await started.json()
  const approvalURL = `${baseURL}/cli/approve?code=${device.user_code}`
  await page.goto(approvalURL)
  await expect(page).toHaveURL(approvalURL)
  await expect(page.getByRole('heading', { name: 'Sign in to Velvet', exact: true })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill(email)
  const since = new Date()
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  const link = await mailLink(email, since, '/signin/confirm')
  const fresh = await context.newPage()
  await fresh.goto(link)
  await fresh.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(fresh).toHaveURL(approvalURL)
  await expect(fresh.getByTestId('cli-user-code')).toHaveText(device.user_code)
  expect(sql(`SELECT count(*) FROM api_token WHERE user_id = (SELECT id FROM app_user WHERE email = '${email}')`)).toBe('0')
  await fresh.getByRole('button', { name: 'Refuse' }).click()
  await expect(fresh.getByText('Refused. The CLI was not given a key.')).toBeVisible()
  await fresh.close()
})

test('velvet login consents in the browser, then init selects a project in the terminal', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'ticket_session', value: session, url: baseURL! }])

  const beforeLogin = velvet(['init', '--server', baseURL!, '--organisation', slug, '--project', 'web', '--non-interactive'])
  expect(beforeLogin.code).toBe(3)
  expect(beforeLogin.err).toContain('velvet login')
  const init = spawn(bin, ['login', '--server', baseURL!, '--no-browser'], { cwd: repo, env: cliEnv })
  let out = ''
  init.stdout.on('data', (d) => { out += d })
  init.stderr.on('data', (d) => { out += d })
  const exited = new Promise<number | null>((done) => init.on('exit', done))

  await expect.poll(() => out.match(/http\S+\/cli\/approve\?code=\S+/)?.[0], { timeout: 15_000 }).toBeTruthy()
  const link = out.match(/http\S+\/cli\/approve\?code=\S+/)![0]
  const code = out.match(/code shown there is (\S+)\./)![1]

  await page.goto(link)
  await expect(page.getByTestId('cli-user-code')).toHaveText(code)
  for (const [width, height] of [[1280, 900], [390, 844]] as const) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await expect(page.getByRole('button', { name: 'Approve login' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: `test-results/cli-login-${width}-${colorScheme}.png`, fullPage: true })
    }
  }
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press('Tab')
    if (await page.getByRole('button', { name: 'Approve login' }).evaluate(el => el === document.activeElement)) break
  }
  await expect(page.getByRole('button', { name: 'Approve login' })).toBeFocused()
  expect(await page.getByRole('button', { name: 'Approve login' }).evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none')
  await page.screenshot({ path: 'test-results/cli-login-390-keyboard.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.screenshot({ path: 'test-results/cli-login-1280-keyboard.png', fullPage: true })
  await expect(page.getByLabel('Organisation')).toHaveCount(0)
  await expect(page.getByLabel('Project', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.getByText('Connected.')).toBeVisible()

  expect(await exited).toBe(0)
  expect(existsSync(join(repo, 'velvet.yaml'))).toBe(false)
  expect(sql(`SELECT kind FROM api_token WHERE user_id = (SELECT id FROM app_user WHERE email = '${email}')`)).toBe('setup')
  const account = spawnSync(bin, ['whoami', '--server', baseURL!], { cwd: scratch, env: cliEnv, encoding: 'utf8' })
  expect(account.status, account.stderr).toBe(0)
  expect(account.stdout).toContain('machine setup only')
  const linked = velvet(['init', '--server', baseURL!, '--organisation', slug, '--project', 'web', '--non-interactive'])
  expect(linked.code, linked.err).toBe(0)
  expect(linked.out).toContain('web')

  const yaml = readFileSync(join(repo, 'velvet.yaml'), 'utf8')
  expect(yaml).toContain(`organisation: ${slug}`)
  expect(yaml).toContain('project: web')
  expect(yaml).not.toMatch(/velvet_[A-Za-z0-9]/)

  // The raw key is never stored server-side, only its hash, with its scope.
  const scope = sql(`
    SELECT w.slug || '/' || p.key FROM api_token t
    JOIN workspace w ON w.id = t.workspace_id JOIN project p ON p.id = t.project_id
    JOIN app_user u ON u.id = t.user_id WHERE u.email = '${email}'
  `)
  expect(scope).toBe(`${slug}/web`)
  const tokenBefore = sql(`SELECT id FROM api_token WHERE project_id IS NOT NULL AND user_id = (SELECT id FROM app_user WHERE email = '${email}')`)
  const again = velvet(['init', '--non-interactive'])
  expect(again.code, again.err).toBe(0)
  expect(sql(`SELECT id FROM api_token WHERE project_id IS NOT NULL AND user_id = (SELECT id FROM app_user WHERE email = '${email}')`)).toBe(tokenBefore)
})

test('the stored key works from a subdirectory and lands work in its project', () => {
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
  const who = spawnSync(bin, ['whoami'], { cwd: join(repo, 'src', 'deep'), env: cliEnv, encoding: 'utf8' })
  expect(who.status, who.stderr).toBe(0)
  expect(who.stdout).toContain('Project: web')

  const created = velvet(['new', 'Ship the CLI'])
  expect(created.code, created.err).toBe(0)
  const key = created.out.match(/CLI-\d+/)![0]

  expect(velvet(['log', key, '--kind', 'decision', 'Use a device flow for init']).code).toBe(0)
  expect(velvet(['log', 'Project-level note from the CLI']).code).toBe(0)

  const ticket = sql(`
    SELECT p.key FROM issue i JOIN project p ON p.id = i.project_id
    JOIN workspace w ON w.id = i.workspace_id WHERE w.slug = '${slug}' AND i.title = 'Ship the CLI'
  `)
  expect(ticket).toBe('web')
  expect(velvet(['issue', key]).out).toContain('Use a device flow for init')
})

test('the key cannot reach another project, even when velvet.yaml is edited to name it', async ({ request, baseURL }) => {
  // Filed by the person in the browser session, in the other project.
  const made = await request.post(`/api/v1/w/${slug}/issues`, {
    headers: { Cookie: `ticket_session=${session}`, Origin: baseURL! },
    data: { title: 'API secret ticket', project: 'api' },
  })
  expect(made.ok(), await made.text()).toBe(true)
  const other = (await made.json()).key as string

  const blocked = velvet(['log', other, 'should not land'])
  expect(blocked.code).not.toBe(0)
  expect(velvet(['issues']).out).not.toContain('API secret ticket')

  const original = readFileSync(join(repo, 'velvet.yaml'), 'utf8')
  for (const tampered of [
    original.replace('project: web', 'project: api'),
    original.replace(`organisation: ${slug}`, 'organisation: other-org'),
    original.replace(baseURL!, 'http://127.0.0.1:1'),
  ]) {
    writeFileSync(join(repo, 'velvet.yaml'), tampered)
    try {
      // The private directory binding rejects edits before selecting a key.
      const swapped = velvet(['issues'])
      expect(swapped.code).not.toBe(0)
      expect(swapped.err).toContain('velvet init')
    } finally {
      writeFileSync(join(repo, 'velvet.yaml'), original)
    }
  }

  const comments = sql(`
    SELECT count(*) FROM comment c JOIN issue i ON i.id = c.target_id WHERE i.title = 'API secret ticket'
  `)
  expect(comments).toBe('0')
})

test('terminal init creates an organisation and project without browser approval', async ({ baseURL }) => {
  const createdRepo = join(scratch, 'created-repo')
  mkdirSync(createdRepo)
  const created = spawnSync(bin, ['init', '--server', baseURL!], {
    cwd: createdRepo, env: cliEnv, encoding: 'utf8',
    input: `0\nCLI Created Org\n${slug}-created\nNEW\n0\nCreated project\ncreated\nyes\n`,
  })
  expect(created.stdout).toContain('Organisation number')
  expect(created.stdout).toContain('Project number')
  expect(created.status, created.stderr).toBe(0)
  expect(readFileSync(join(createdRepo, 'velvet.yaml'), 'utf8')).toContain('project: created')
  expect(sql(`SELECT p.key FROM project p JOIN workspace w ON w.id = p.workspace_id WHERE w.slug = '${slug}-created'`)).toBe('created')
})

test('velvet logout revokes setup access and every child repository key', async ({ page, context, baseURL }) => {
  const second = join(scratch, 'second-repo')
  mkdirSync(second)
  const linked = spawnSync(bin, ['init', '--server', baseURL!, '--organisation', slug, '--project', 'api', '--non-interactive'], { cwd: second, env: cliEnv, encoding: 'utf8' })
  expect(linked.status, linked.stderr).toBe(0)
  await context.addCookies([{ name: 'ticket_session', value: session, url: baseURL! }])
  await page.goto(`/w/${slug}/settings/profile/tokens`)
  const setup = page.getByRole('listitem').filter({ hasText: 'Machine setup key' })
  await expect(setup).toHaveCount(1)
  await expect(page.getByText(`Derived project key · ${slug} / web`, { exact: true })).toBeVisible()
  const countBefore = sql(`SELECT count(*) FROM api_token WHERE user_id = (SELECT id FROM app_user WHERE email = '${email}')`)
  await setup.getByRole('button', { name: /^Revoke / }).click()
  const confirmation = setup.getByRole('group')
  await expect(confirmation).toContainText('all project keys derived from it')
  await expect(confirmation).toContainText('Every repository using those keys will stop working.')
  for (const [width, height, colorScheme] of [[1280, 900, 'light'], [390, 844, 'dark']] as const) {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await confirmation.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
    const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true })
    await expect(cancel).toBeInViewport()
    expect(await cancel.evaluate(el => {
      const rect = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/cli-setup-revoke-${width}.png` })
  }
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  expect(sql(`SELECT count(*) FROM api_token WHERE user_id = (SELECT id FROM app_user WHERE email = '${email}')`)).toBe(countBefore)
  const out = velvet(['logout', '--server', baseURL!])
  expect(out.code, out.err).toBe(0)
  const live = sql(`
    SELECT count(*) FROM api_token t JOIN app_user u ON u.id = t.user_id
    WHERE u.email = '${email}'
  `)
  expect(live).toBe('0')
  const revoked = spawnSync(bin, ['issues'], { cwd: second, env: cliEnv, encoding: 'utf8' })
  expect(revoked.status).not.toBe(0)
  expect(readFileSync(join(repo, 'velvet.yaml'), 'utf8')).toContain('project: web')
  expect(velvet(['whoami', '--server', baseURL!]).code).toBe(3)
})
