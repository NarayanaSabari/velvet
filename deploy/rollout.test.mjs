import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')

test('ordinary Compose deployment forwards the App slug without a custom installation endpoint', () => {
  const result = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', 'compose', '--env-file', '/dev/null',
    '-f', join(root, 'deploy/docker-compose.yml'), 'config', '--format', 'json'], {
    env: { HOME: process.env.HOME, PATH: process.env.PATH,
      DATABASE_URL: 'postgres://test', POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test',
      BASE_URL: 'http://localhost', SITE_ADDRESS: 'http://localhost', GITHUB_APP_SLUG: 'worklog-test-app',
      GITHUB_WEBHOOK_SECRET: '', GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const api = JSON.parse(result.stdout).services.api.environment
  assert.equal(api.GITHUB_APP_SLUG, 'worklog-test-app')
  assert.equal(api.GITHUB_INSTALLATION_URL, '')
  assert.equal(Object.hasOwn(api, 'GITHUB_CLIENT_ID'), false)
  assert.equal(Object.hasOwn(api, 'GITHUB_CLIENT_SECRET'), false)
})

for (const script of ['verify-setup.sh', 'verify-localhost.sh']) {
  test(`${script} discovers the shared onboarding journeys`, () => {
    const result = spawnSync('bash', [join(root, 'deploy', script), '--list'], {
      cwd: root, env: { HOME: process.env.HOME, PATH: process.env.PATH }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Total: 3 tests in 1 file/)
    assert.match(result.stdout, /owner-verified GitHub setup/)
  })
}

function runPreflight({ databaseFailure = false, slug } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'worklog-preflight-'))
  try {
    const calls = join(temp, 'calls')
    // Only external process boundaries are substituted. The real preflight
    // reads the approved disposable test configuration and makes its decisions.
    writeFileSync(join(temp, 'curl'), `#!${process.execPath}\nimport('node:fs').then(({appendFileSync}) => {
      const args = process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
      if (args.includes('%{http_code}')) process.stdout.write(args.some(a => a.includes('deadbeef')) ? '401' : '200');
    });\n`, { mode: 0o755 })
    writeFileSync(join(temp, 'docker'), databaseFailure ? '#!/bin/sh\nexit 9\n' : '#!/bin/sh\nprintf "0\\n"\n', { mode: 0o755 })
    const result = spawnSync('bash', [join(root, 'deploy/preflight.sh'), ...(slug ? [slug] : [])], {
      cwd: root, env: { HOME: process.env.HOME, PATH: `${temp}:${process.env.PATH}`,
        ENV_FILE: join(root, 'e2e/.env.generated'), COMPOSE_PROJECT: 'worklog-e2e-organisations' }, encoding: 'utf8',
    })
    return { ...result, calls: slug ? '' : readFileSync(calls, 'utf8') }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

test('preflight accepts email onboarding before the first organisation or repository exists', () => {
  const result = runPreflight()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /email sign-in page is reachable/)
  assert.match(result.stdout, /log mailer/)
  assert.match(result.stdout, /Create an organisation/)
  assert.doesNotMatch(result.calls, /auth\/github\/login|auth\/email|auth\/magic/)
})

test('preflight fails when the database cannot be checked', () => {
  const result = runPreflight({ databaseFailure: true })
  assert.equal(result.status, 9, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /checks passed/)
})

test('preflight rejects SQL punctuation in the organisation slug before checking the deployment', () => {
  const result = runPreflight({ slug: "lab'; SELECT 1; --" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /invalid organisation slug/)
  assert.equal(result.stdout, '')
})
