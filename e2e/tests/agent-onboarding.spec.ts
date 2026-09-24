import { test, expect } from '@playwright/test'
import { sql } from './fixtures'
import { signup, unique } from './onboarding-helpers'

/**
 * The first-run path a real person takes: sign up, accept an organisation
 * named after them, create a key, paste it into their agent, and see the
 * agent arrive. The agent is played by a real MCP client speaking the
 * protocol over HTTP to the hosted endpoint, with the key the page showed.
 */
test('a new person connects a coding agent through onboarding', async ({ page, baseURL }) => {
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

  // Step 2: one key for the agent.
  await page.getByRole('button', { name: 'Create API key' }).click()

  // Step 3: the key, URL, and per-agent config, waiting for the agent.
  const token = (await page.getByTestId('onboarding-token').textContent())!.trim()
  expect(token).toMatch(/^velvet_[0-9a-f]+$/)
  const url = (await page.getByTestId('onboarding-mcp-url').textContent())!.trim()
  expect(url).toBe(`${baseURL}/api/v1/w/${slug}/mcp`)
  await expect(page.getByTestId('onboarding-snippet')).toContainText(`claude mcp add --transport http --scope user velvet ${url}`)
  await page.getByRole('tab', { name: 'Cursor' }).click()
  expect(JSON.parse((await page.getByTestId('onboarding-snippet').textContent())!)).toEqual({
    mcpServers: { velvet: { url, headers: { Authorization: `Bearer ${token}` } } },
  })
  const connection = page.getByTestId('onboarding-connection')
  await expect(connection).toHaveAttribute('data-connected', 'false')
  await expect(connection).toContainText('Waiting for your agent')

  // The agent connects with exactly what the page showed.
  const call = async (id: number, method: string, params: object) => {
    const response = await page.request.post(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      data: { jsonrpc: '2.0', id, method, params },
    })
    expect(response.status(), await response.text()).toBe(200)
    return response.json()
  }
  const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-agent', version: '1' } })
  expect(init.result.serverInfo.name).toBe('velvet')
  const tools = await call(2, 'tools/list', {})
  expect(tools.result.tools.map((t: { name: string }) => t.name)).toContain('velvet_log_work')
  const where = await call(3, 'tools/call', { name: 'velvet_where_am_i', arguments: {} })
  expect(where.result.isError ?? false).toBe(false)
  expect(where.result.content[0].text).toContain(`(${slug})`)
  expect(where.result.content[0].text).toContain('Role: admin')

  // The page notices the agent without a reload.
  await expect(connection).toHaveAttribute('data-connected', 'true', { timeout: 15000 })
  await expect(connection).toContainText('Your agent is connected.')

  // The agent writes real work, which lands in the new organisation.
  const created = await call(4, 'tools/call', { name: 'velvet_create_ticket', arguments: { title: 'Connect my agent to Velvet' } })
  expect(created.result.isError ?? false).toBe(false)
  const key = /Created ([A-Z]+-\d+)/.exec(created.result.content[0].text)![1]!
  const logged = await call(5, 'tools/call', { name: 'velvet_log_work', arguments: { key, body: 'Connected through onboarding.' } })
  expect(logged.result.isError ?? false).toBe(false)

  await page.getByRole('link', { name: 'Go to your dashboard' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`))
  await expect(page.getByTestId('connect-agent-card')).toHaveCount(0)
  await page.goto(`/w/${slug}/issues/${key}`)
  await expect(page.getByText('Connected through onboarding.')).toBeVisible()
  expect(sql(`SELECT c.source FROM comment c JOIN issue i ON i.id = c.target_id WHERE i.key = '${key}'`)).toBe('agent')
})

test('a person who skips the agent sees the connect card, and existing members skip onboarding', async ({ page }) => {
  test.setTimeout(90000)
  const suffix = unique()
  await signup(page, `skip.${suffix}@example.test`)
  await page.getByRole('button', { name: 'Create organisation' }).click()
  await page.getByRole('link', { name: 'Skip for now and go to your dashboard' }).click()
  await expect(page).toHaveURL(new RegExp(`/w/skip-${suffix}$`))

  const card = page.getByTestId('connect-agent-card')
  await expect(card).toBeVisible()
  await card.getByRole('link', { name: 'Connect an agent' }).click()
  await expect(page).toHaveURL(/\/onboarding$/)
  // Having an organisation already, they resume at the key step.
  await expect(page.getByRole('button', { name: 'Create API key' })).toBeVisible()

  // Returning to the root goes straight to the organisation, not onboarding.
  await page.goto('/')
  await expect(page).toHaveURL(new RegExp(`/w/skip-${suffix}$`))
  await page.getByTestId('connect-agent-card').getByRole('button', { name: 'Not now' }).click()
  await expect(page.getByTestId('connect-agent-card')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await expect(page.getByTestId('connect-agent-card')).toHaveCount(0)
})

test('onboarding and the hosted MCP stay usable on a phone', async ({ page }) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 390, height: 844 })
  const suffix = unique()
  await signup(page, `phone.${suffix}@example.test`)
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(await overflow()).toBeLessThanOrEqual(0)
  await page.getByRole('button', { name: 'Create organisation' }).click()
  await page.getByRole('button', { name: 'Create API key' }).click()
  await expect(page.getByTestId('onboarding-token')).toBeVisible()
  for (const tab of ['Claude Code', 'Codex', 'Cursor', 'VS Code', 'Other']) {
    await page.getByRole('tab', { name: tab }).click()
    expect(await overflow(), `${tab} widened the page`).toBeLessThanOrEqual(0)
  }
  await page.screenshot({ path: 'test-results/onboarding-connect-390.png', fullPage: true })
})
