import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

// Disposable provider double for real browser/API integration, not production.
const codes = new Map()
const tokens = new Set()
const installationTokens = new Map()
const control = { repositoryPresent: true, failListing: false, suspended: false, deleted: false, installationID: 99, readOnly: false }
const stats = { authorizations: 0, exchanges: 0, pkceVerified: 0, users: 0, installations: 0, installationTokens: 0, repositoryLists: 0 }
const baseURL = process.env.BASE_URL || 'http://localhost:18399'
const callback = `${baseURL}/api/v1/auth/github/callback`
const clientId = 'local-github-client'
const clientSecret = 'local-github-secret'
const identity = { id: 70007, login: 'runtime-github-user', name: 'Runtime GitHub User', avatar_url: '' }

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:18599')
  if (req.method === 'GET' && url.pathname === '/test/stats') return json(res, 200, { ...stats, control })
  if (req.method === 'POST' && url.pathname === '/test/control') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 8192) return json(res, 413, { error: 'too_large' })
    }
    let update
    try { update = JSON.parse(body) } catch { return json(res, 400, { error: 'invalid_test_control' }) }
    if (!update || typeof update !== 'object' || Array.isArray(update) || Object.entries(update).some(([key, value]) => !(key in control) || (key === 'installationID' ? ![99, 100].includes(value) : typeof value !== 'boolean'))) {
      return json(res, 400, { error: 'invalid_test_control' })
    }
    Object.assign(control, update)
    return json(res, 200, control)
  }
  if (req.method === 'GET' && url.pathname === '/install') {
    const state = url.searchParams.get('state') || ''
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return json(res, 400, { error: 'invalid_installation_state' })
    stats.installations++
    const destination = new URL(`${baseURL}/api/v1/github/setup`)
    destination.searchParams.set('installation_id', String(control.installationID))
    destination.searchParams.set('state', state)
    res.writeHead(302, { Location: destination.href })
    return res.end()
  }
  if (req.method === 'GET' && /^\/app\/installations\/(99|100)$/.test(url.pathname)) {
    if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(req.headers.authorization || '')) return json(res, 401, { message: 'Missing test App assertion' })
    if (control.deleted || Number(url.pathname.split('/').at(-1)) !== control.installationID) return json(res, 404, { message: 'Test installation not found' })
    return json(res, 200, { id: control.installationID, account: { id: 70007, login: identity.login, type: 'Organization' }, suspended_at: control.suspended ? new Date().toISOString() : null, suspended_by: control.suspended ? { login: identity.login } : null })
  }
  if (req.method === 'POST' && /^\/app\/installations\/(99|100)\/access_tokens$/.test(url.pathname)) {
    // This disposable double accepts only the shape of a locally generated JWT.
    if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(req.headers.authorization || '')) {
      return json(res, 401, { message: 'Missing test App assertion' })
    }
    if (control.deleted || control.suspended || Number(url.pathname.split('/')[3]) !== control.installationID) return json(res, 403, { message: 'Test installation is inactive' })
    const token = randomBytes(24).toString('base64url')
    installationTokens.set(token, control.installationID)
    stats.installationTokens++
    return json(res, 201, { token, expires_at: new Date(Date.now() + 3600000).toISOString() })
  }
  if (req.method === 'GET' && url.pathname === '/authorize') {
    const p = url.searchParams
    if (p.get('client_id') !== clientId || p.get('redirect_uri') !== callback ||
        p.get('code_challenge_method') !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(p.get('state') || '') ||
        !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') || '')) {
      return json(res, 400, { error: 'invalid_authorization_request' })
    }
    const code = randomBytes(24).toString('base64url')
    codes.set(code, p.get('code_challenge'))
    stats.authorizations++
    const destination = new URL(callback)
    destination.searchParams.set('code', code)
    destination.searchParams.set('state', p.get('state'))
    res.writeHead(302, { Location: destination.href })
    return res.end()
  }
  if (req.method === 'POST' && url.pathname === '/token') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 8192) return json(res, 413, { error: 'too_large' })
    }
    const p = new URLSearchParams(body)
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    if (!(p.get('client_id') === clientId && p.get('client_secret') === clientSecret) &&
        req.headers.authorization !== `Basic ${basic}`) return json(res, 401, { error: 'invalid_client' })
    stats.exchanges++
    const challenge = codes.get(p.get('code'))
    codes.delete(p.get('code'))
    if (!challenge || p.get('redirect_uri') !== callback ||
        createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== challenge) {
      return json(res, 400, { error: 'invalid_grant' })
    }
    stats.pkceVerified++
    const token = randomBytes(24).toString('base64url')
    tokens.add(token)
    return json(res, 200, { access_token: token, token_type: 'bearer', expires_in: 3600 })
  }
  const token = (req.headers.authorization || '').replace(/^Bearer /i, '')
  if (installationTokens.get(token) === control.installationID && !control.deleted && !control.suspended) {
    if (req.method === 'GET' && url.pathname === '/installation/repositories') {
      stats.repositoryLists++
      if (control.failListing) return json(res, 503, { message: 'Synthetic provider failure, must not be exposed' })
      return json(res, 200, { total_count: control.repositoryPresent ? 1 : 0, repositories: control.repositoryPresent ? [{ id: 90099, owner: { login: identity.login }, name: 'runtime-repo', full_name: `${identity.login}/runtime-repo`, default_branch: 'main' }] : [] })
    }
    if (req.method === 'GET' && /^\/repos\/runtime-github-user\/runtime-repo\/(pulls|commits)$/.test(url.pathname)) return json(res, 200, [])
  }
  if (!tokens.has(token)) return json(res, 401, { message: 'Bad credentials' })
  if (req.method === 'GET' && url.pathname === '/user') {
    stats.users++
    return json(res, 200, identity)
  }
  if (req.method === 'GET' && url.pathname === '/user/installations') {
    return json(res, 200, { total_count: control.deleted ? 0 : 1, installations: control.deleted ? [] : [{ id: control.installationID, account: { id: 70007, login: identity.login, type: 'Organization' } }] })
  }
  if (req.method === 'GET' && url.pathname === '/user/memberships/orgs') return json(res, 200, [{ organization: { id: 70007 }, state: 'active', role: control.readOnly ? 'member' : 'admin' }])
  json(res, 404, { message: 'Not found' })
}).listen(18599, '0.0.0.0', () => console.log('Test-only GitHub profile stub listening on 18599'))
