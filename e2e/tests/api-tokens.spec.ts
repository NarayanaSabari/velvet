import { test, expect, resetWorkspaceData } from './fixtures'

test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  resetWorkspaceData()
})

test('creates an API token and uses it to create an issue', async ({
  signedIn: page,
  playwright,
  baseURL,
  request,
}) => {
  await page.goto('/w/lab/settings/profile')
  await expect(page.getByRole('heading', { name: 'API tokens' })).toBeVisible()

  const tokenName = `CLI writer ${Date.now()}`
  await page.getByLabel('Token name').fill(tokenName)
  await page.getByRole('button', { name: 'Create token' }).click()

  const tokenBlock = page.getByRole('status').locator('code')
  await expect(tokenBlock).toHaveText(/^velvet_/)
  const token = (await tokenBlock.textContent())?.trim()
  if (!token) throw new Error('The API token was not displayed after creation')
  await expect(page.getByText(/This token will not be shown again/)).toBeVisible()
  await expect(page.getByText(tokenName, { exact: true })).toBeVisible()

  const tokenList = await request.get('/api/v1/me/tokens').then((response) => response.json()) as {
    tokens: { id: string; name: string }[]
  }
  const created = tokenList.tokens.find((candidate) => candidate.name === tokenName)
  expect(created).toBeDefined()
  if (!created) throw new Error('The created API token was not listed by the API')

  const bearer = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
      Origin: baseURL!,
      'Content-Type': 'application/json',
    },
  })

  try {
    const issueTitle = `Written by API token ${Date.now()}`
    const issueResponse = await bearer.post('/api/v1/w/lab/issues', {
      data: { title: issueTitle },
    })
    expect(issueResponse.status()).toBe(201)
    const issue = await issueResponse.json() as { key: string }

    await page.goto(`/w/lab/issues/${issue.key}`)
    await expect(page.getByRole('heading', { name: issueTitle, exact: true })).toBeVisible()
  } finally {
    await bearer.dispose()
    // Keep repeated local runs below the account's token cap.
    await request.delete(`/api/v1/me/tokens/${created.id}`)
  }
})
