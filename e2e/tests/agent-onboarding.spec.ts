import { test, expect, type Page } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from './fixtures'
import { signup, unique } from './onboarding-helpers'
import { velvetBinary } from './velvet-cli'

/**
 * Runs browser login first, then runs the page's terminal init command.
 * Returns a runner for further commands in that repository.
 */
async function linkWithPageCommand(page: Page, initCommand: string, slug: string, project: string) {
  const repo = mkdtempSync(join(tmpdir(), 'velvet-onboarding-'))
  const env = { ...process.env, VELVET_NO_KEYCHAIN: '1', VELVET_TOKEN: '', HOME: repo, XDG_CONFIG_HOME: join(repo, '.config') }
  const args = initCommand.split(' ').slice(1)
  expect(initCommand.split(' ')[0]).toBe('velvet')
  const server = args[args.indexOf('--server') + 1]!
  const init = spawn(velvetBinary(), ['login', '--server', server, '--no-browser'], { cwd: repo, env })
  let out = ''
  init.stdout.on('data', (d) => { out += d })
  init.stderr.on('data', (d) => { out += d })
  const exited = new Promise<number | null>((done) => init.on('exit', done))
  await expect.poll(() => /http\S+\/cli\/approve\?code=\S+/.exec(out)?.[0], { timeout: 15000 }).toBeTruthy()

  const approval = await page.context().newPage()
  await approval.goto(/http\S+\/cli\/approve\?code=\S+/.exec(out)![0])
  await approval.getByRole('button', { name: 'Approve login' }).click()
  await expect(approval.getByText('Connected.')).toBeVisible()
  await approval.close()
  expect(await exited, out).toBe(0)
  const linked = spawnSync(velvetBinary(), [...args, '--organisation', slug, '--project', project, '--non-interactive'], { cwd: repo, env, encoding: 'utf8' })
  expect(linked.status, linked.stderr).toBe(0)
  expect(readFileSync(join(repo, 'velvet.yaml'), 'utf8')).toContain(`project: ${project}`)

  return (cmd: string[]) => {
    const r = spawnSync(velvetBinary(), cmd, { cwd: repo, env, encoding: 'utf8' })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
}

/**
 * The first-run path a real person takes: sign up, accept an organisation
 * named after them, create its first project, then link a repository with
 * the real CLI using the exact command the page showed, and see it arrive.
 */
test('a new person links a repository through onboarding', async ({ page, baseURL }) => {
  test.setTimeout(120000)
  const suffix = unique()
  const email = `nila.${suffix}@example.test`
  await signup(page, email)

  // Step 1: the organisation defaults to the person, from their email here.
  await expect(page.getByRole('heading', { level: 1, name: 'Set up Velvet' })).toBeVisible()
  const preview = page.getByTestId('onboarding-org-preview')
  await expect(preview.getByText(`Nila ${suffix[0]!.toUpperCase()}${suffix.slice(1)}`, { exact: true })).toBeVisible()
  const address = (await preview.locator('dd').first().textContent())!.trim()
  const slug = address.replace('/w/', '')
  expect(slug).toBe(`nila-${suffix}`)
  await page.getByRole('button', { name: 'Create organisation' }).click()

  // Step 2: a project first, then the install and link commands.
  const setup = page.getByTestId('repo-setup')
  await expect(setup.getByText('Create a project first')).toBeVisible()
  await setup.getByLabel('Project name').fill('Nila Site')
  await expect(setup.getByLabel('Project key')).toHaveValue('nila-site')
  await setup.getByRole('button', { name: 'Create project' }).click()
  await expect(setup.getByTestId('cli-install')).toHaveText(`curl -fsSL ${baseURL}/install.sh | VELVET_SERVER=${baseURL} sh`)
  await expect(setup.getByTestId('cli-login')).toHaveText(`velvet login --server ${baseURL}`)
  const initCommand = (await setup.getByTestId('cli-init').textContent())!.trim()
  expect(initCommand).toBe(`velvet init --server ${baseURL}`)
  await expect(page.getByText(/velvet_[0-9a-f]{8,}/)).toHaveCount(0)
  const connection = page.getByTestId('agent-connection')
  await expect(connection).toHaveAttribute('data-connected', 'false')
  await expect(connection).toContainText('Waiting for velvet init')

  // The person runs it; the page notices the repository without a reload.
  const velvet = await linkWithPageCommand(page, initCommand, slug, 'nila-site')
  await expect(connection.getByRole('list', { name: 'Linked repositories' })).toContainText('nila-site', { timeout: 15000 })
  const who = velvet(['whoami'])
  expect(who.code, who.err).toBe(0)
  expect(who.out).toContain('Project: nila-site')
  await expect(connection).toHaveAttribute('data-connected', 'true', { timeout: 15000 })
  await expect(connection).toContainText('Your agent is connected.')

  // The agent writes real work, which lands in the new organisation.
  const created = velvet(['new', 'Connect my agent to Velvet'])
  expect(created.code, created.err).toBe(0)
  const key = /[A-Z]+-\d+/.exec(created.out)![0]
  expect(velvet(['log', key, 'Connected through onboarding.']).code).toBe(0)

  await page.getByRole('link', { name: 'Go to your dashboard' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`))
  await expect(page.getByTestId('connect-agent-card')).toHaveCount(0)
  await page.goto(`/w/${slug}/issues/${key}`)
  await expect(page.getByText('Connected through onboarding.')).toBeVisible()
  expect(sql(`SELECT c.source FROM comment c JOIN issue i ON i.id = c.target_id JOIN workspace w ON w.id = i.workspace_id WHERE w.slug = '${slug}' AND i.key = '${key}' AND c.body = 'Connected through onboarding.'`)).toBe('agent')
})

test('a person who skips the agent links a repository later from Profile > Agent config', async ({ page, baseURL }) => {
  test.setTimeout(120000)
  const suffix = unique()
  const slug = `skip-${suffix}`
  await signup(page, `skip.${suffix}@example.test`)
  await page.getByRole('button', { name: 'Create organisation' }).click()
  await expect(page.getByText('You can connect more repositories later from Profile, under Agent config.')).toBeVisible()
  await page.getByRole('link', { name: 'Go to your dashboard' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`))

  // Returning to the root goes straight to the organisation, not onboarding.
  await page.goto('/')
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`))

  // The dashboard prompt leads to the Agent config section of Profile.
  const card = page.getByTestId('connect-agent-card')
  await expect(card).toBeVisible()
  await card.getByRole('link', { name: 'Connect an agent' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/settings/profile/agent-config$`))
  const section = page.locator('section#agent-config')
  await expect(section.getByRole('heading', { name: 'Agent config' })).toBeInViewport()
  await expect(section.getByTestId('agent-connection')).toContainText('Waiting for velvet init')

  // Create the first project in place, then take the commands and the block.
  const setup = section.getByTestId('repo-setup')
  await setup.getByLabel('Project name').fill('Skip Site')
  await setup.getByRole('button', { name: 'Create project' }).click()
  await expect(setup.getByTestId('cli-login')).toHaveText(`velvet login --server ${baseURL}`)
  const initCommand = (await setup.getByTestId('cli-init').textContent())!.trim()
  const block = (await setup.getByTestId('repo-instructions').textContent())!
  expect(block).toContain('## Velvet work log')
  expect(block).toContain('velvet log KEY')
  expect(block).not.toMatch(/velvet_[0-9a-f]{8,}|Bearer|mcp/i)
  // Tokens are on their own page, not mounted alongside the setup.
  await expect(page.getByLabel('Token name')).toHaveCount(0)
  for (const [width, height, colorScheme] of [[1280, 900, 'light'], [390, 844, 'dark']] as const) {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await expect(setup.getByTestId('cli-init')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/agent-config-${width}-${colorScheme}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1280, height: 900 })

  const velvet = await linkWithPageCommand(page, initCommand, slug, 'skip-site')
  const logged = velvet(['log', 'Set up Velvet for this repository.'])
  expect(logged.code, logged.err).toBe(0)
  expect(logged.out).toContain('Logged to project skip-site')
  await expect(section.getByTestId('agent-connection')).toHaveAttribute('data-connected', 'true', { timeout: 15000 })
  await expect(section.getByRole('list', { name: 'Linked repositories' })).toContainText('skip-site')
  expect(sql(`SELECT c.source FROM comment c JOIN project p ON p.id = c.target_id JOIN workspace w ON w.id = p.workspace_id WHERE w.slug = '${slug}' AND p.key = 'skip-site' AND c.body = 'Set up Velvet for this repository.'`)).toBe('agent')

  // With an agent connected, the dashboard prompt is gone.
  await page.goto(`/w/${slug}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await expect(page.getByTestId('connect-agent-card')).toHaveCount(0)
})

test('the dashboard prompt can be dismissed, and Agent config stays in Profile', async ({ page }) => {
  test.setTimeout(90000)
  const suffix = unique()
  await signup(page, `later.${suffix}@example.test`)
  await page.getByRole('button', { name: 'Create organisation' }).click()
  await page.getByRole('link', { name: 'Go to your dashboard' }).click()
  await page.getByTestId('connect-agent-card').getByRole('button', { name: 'Not now' }).click()
  await expect(page.getByTestId('connect-agent-card')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await expect(page.getByTestId('connect-agent-card')).toHaveCount(0)

  // The command palette still reaches Agent config after the prompt is gone.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await page.keyboard.type('agent config')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/w/later-${suffix}/settings/profile/agent-config$`))
  await expect(page.getByTestId('repo-setup')).toBeVisible()
})

test('onboarding and Agent config stay usable on a phone', async ({ page }) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 390, height: 844 })
  const suffix = unique()
  await signup(page, `phone.${suffix}@example.test`)
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(await overflow()).toBeLessThanOrEqual(0)
  await page.getByRole('button', { name: 'Create organisation' }).click()
  const setup = page.getByTestId('repo-setup')
  await setup.getByLabel('Project name').fill('A phone project with a rather long descriptive name')
  await setup.getByRole('button', { name: 'Create project' }).click()
  await expect(setup.getByTestId('cli-install')).toBeVisible()
  for (const tab of ['AGENTS.md', 'CLAUDE.md', 'Cursor rule']) {
    await setup.getByRole('tab', { name: tab }).click()
    expect(await overflow(), `${tab} widened the page`).toBeLessThanOrEqual(0)
  }
  await page.screenshot({ path: 'test-results/onboarding-connect-390.png', fullPage: true })

  // The same setup in Profile > Agent config fits the phone as well.
  await page.goto(`/w/phone-${suffix}/settings/profile#agent-config`)
  await expect(page.getByTestId('cli-init')).toBeVisible()
  expect(await overflow(), 'Agent config widened the profile page').toBeLessThanOrEqual(0)
  await page.screenshot({ path: 'test-results/profile-agent-config-390.png', fullPage: true })
})
