import { expect, type Page, type APIRequestContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { compose, signWebhook, sql } from './fixtures'

export const unique = () => randomUUID().slice(0, 8)
export const providerURL = `http://127.0.0.1:${process.env.E2E_PROVIDER_PORT ?? 18599}`

/** Scope each capture to its recipient and action time, preserving fragments. */
export async function mailLink(email: string, since: Date, path: string, previous?: string): Promise<string> {
  let link = ''
  await expect.poll(() => {
    const lines = compose(['logs', '--no-color', '--no-log-prefix', '--since', since.toISOString(), 'api']).split('\n')
    for (const line of lines) {
      if (!line.includes(`to=${email} `) && !line.includes(`to="${email}" `)) continue
      const links = line.match(/https?:\/\/[^\s"\]<>]+/g) ?? []
      const candidate = links.find((value) => new URL(value).pathname === path && value !== previous)
      if (candidate) link = candidate
    }
    return link
  }, { message: `new ${path} mail for ${email}`, timeout: 15000 }).not.toBe('')
  expect(new URL(link).hash).not.toBe('')
  return link
}

export async function requestSignIn(page: Page, email: string): Promise<string> {
  await page.goto('/signin')
  await page.getByLabel('Email', { exact: true }).fill(email)
  const since = new Date()
  await page.getByRole('button', { name: 'Send sign-in link' }).click()
  await expect(page).toHaveURL(/\/check-email$/)
  return mailLink(email, since, '/signin/confirm')
}

export async function signup(page: Page, email: string): Promise<string> {
  const link = await requestSignIn(page, email)
  await page.goto(link)
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  const before = await page.request.get('/api/v1/me')
  expect(before.status()).toBe(401)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  // A person with no organisation is guided through setup first.
  await expect(page).toHaveURL(/\/onboarding$/)
  return link
}

export async function createOrganisation(page: Page, slug: string, name: string) {
  await page.goto('/orgs/new')
  await page.getByLabel('Organisation name').fill(name)
  await page.getByLabel('Slug', { exact: true }).fill(slug)
  await page.getByLabel('Issue prefix').fill('ORG')
  await page.getByRole('button', { name: 'Create organisation', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${slug}$`))
}

export async function invite(page: Page, slug: string, email: string): Promise<string> {
  await page.goto(`/w/${slug}/admin`)
  await page.getByLabel('Invite email', { exact: true }).fill(email)
  const since = new Date()
  await page.getByRole('button', { name: 'Send invite', exact: true }).click()
  await expect(page.getByLabel('Invite email', { exact: true })).toHaveValue('')
  return mailLink(email, since, '/invite')
}

export async function control(request: APIRequestContext, update: Record<string, boolean | number>) {
  const response = await request.post(`${providerURL}/test/control`, { data: update })
  expect(response.status()).toBe(200)
}

export async function deliver(request: APIRequestContext, event: string, payload: object) {
  const id = `onboarding-${randomUUID()}`
  const body = JSON.stringify(payload)
  const response = await request.post('/webhooks/github', {
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': id, 'X-Hub-Signature-256': signWebhook(body) },
    data: body,
  })
  expect(response.status()).toBe(200)
  await expect.poll(() => sql(`SELECT processed_at IS NOT NULL FROM github_event WHERE delivery_id='${id}'`), { timeout: 20000 }).toBe('t')
}
