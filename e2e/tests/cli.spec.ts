import { test, expect } from '@playwright/test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from './fixtures'

/**
 * The velvet CLI end to end: `velvet init` in a fresh repository, approval in
 * the browser, then real commands with the project-scoped key it stored. The
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
    DELETE FROM workspace WHERE slug = '${slug}';
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

  // A missing binary is a 404, never the SPA's index.html saved as a program.
  expect((await request.get('/download/velvet-plan9-mips')).status()).toBe(404)
})

test('velvet init links the repository after approval in the browser', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'ticket_session', value: session, url: baseURL! }])

  const init = spawn(bin, ['init', '--server', baseURL!, '--no-browser'], { cwd: repo, env: cliEnv })
  let out = ''
  init.stdout.on('data', (d) => { out += d })
  init.stderr.on('data', (d) => { out += d })
  const exited = new Promise<number | null>((done) => init.on('exit', done))

  await expect.poll(() => out.match(/http\S+\/cli\/approve\?code=\S+/)?.[0], { timeout: 15_000 }).toBeTruthy()
  const link = out.match(/http\S+\/cli\/approve\?code=\S+/)![0]
  const code = out.match(/code shown there is (\S+),/)![1]

  await page.goto(link)
  await expect(page.getByTestId('cli-user-code')).toHaveText(code)
  await page.getByLabel('Organisation').selectOption(slug)
  await page.getByLabel('Project').selectOption('web')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByText('Connected.')).toBeVisible()

  expect(await exited).toBe(0)
  expect(out).toContain('Linked to Web app (web)')

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
})

test('the stored key works from a subdirectory and lands work in its project', () => {
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
  const who = spawnSync(bin, ['whoami'], { cwd: join(repo, 'src', 'deep'), env: cliEnv, encoding: 'utf8' })
  expect(who.stderr).toBe('')
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
  writeFileSync(join(repo, 'velvet.yaml'), original.replace('project: web', 'project: api'))
  try {
    // The key for "api" was never issued on this machine, so nothing is sent.
    const swapped = velvet(['issues'])
    expect(swapped.code).toBe(3)
    expect(swapped.err).toContain('velvet init')
  } finally {
    writeFileSync(join(repo, 'velvet.yaml'), original)
  }

  const comments = sql(`
    SELECT count(*) FROM comment c JOIN issue i ON i.id = c.target_id WHERE i.title = 'API secret ticket'
  `)
  expect(comments).toBe('0')
})

test('velvet logout revokes the key on the server', () => {
  const out = velvet(['logout'])
  expect(out.code, out.err).toBe(0)
  const live = sql(`
    SELECT count(*) FROM api_token t JOIN app_user u ON u.id = t.user_id
    WHERE u.email = '${email}'
  `)
  expect(live).toBe('0')
  expect(velvet(['whoami']).code).toBe(3)
})
