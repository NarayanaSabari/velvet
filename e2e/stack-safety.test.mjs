import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const entrypoints = {
  shell: ['bash', ['-c', 'source ./stack-common.sh; compose config --format json']],
  fixtures: [process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', "import { compose } from './tests/fixtures.ts'; process.stdout.write(compose(['config', '--format', 'json']))"]],
}

for (const [name, [command, args]] of Object.entries(entrypoints)) {
  test(`${name} Compose config ignores inherited database and image settings`, () => {
    const result = spawnSync(command, args, {
      cwd: import.meta.dirname,
      env: { ...process.env, E2E_PROJECT: 'worklog-e2e-organisations',
        DATABASE_URL: 'postgres://sentinel.invalid/not-a-test', IMAGE_REPO: 'sentinel/production', IMAGE_TAG: 'production',
        BASE_URL: 'https://sentinel.invalid', SITE_ADDRESS: 'https://sentinel.invalid',
        POSTGRES_USER: 'sentinel', POSTGRES_PASSWORD: 'sentinel', POSTGRES_DB: 'sentinel',
        PROXY_SUBNET: '10.99.0.0/24', PROXY_API_IP: '10.99.0.3', PROXY_CADDY_IP: '10.99.0.2',
        COMPOSE_PROJECT_NAME: 'sentinel-production', COMPOSE_PROFILES: 'sentinel',
      }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(result.stdout)
    assert.equal(config.name, 'worklog-e2e-organisations')
    for (const service of ['migrate', 'api', 'worker']) {
      assert.equal(config.services[service].environment.DATABASE_URL, 'postgres://worklog:e2e-local-only@postgres:5432/worklog?sslmode=disable')
      assert.equal(config.services[service].image, 'worklog-e2e-organisations/api:test')
    }
    assert.equal(config.services.web.image, 'worklog-e2e-organisations/web:test')
    assert.equal(config.services.postgres.environment.POSTGRES_DB, 'worklog')
    assert.equal(config.services.api.environment.BASE_URL, 'http://localhost:18399')
    assert.equal(config.networks.proxy.ipam.config[0].subnet, '172.30.77.0/24')
  })

  test(`${name} Docker boundary ignores inherited remote targets and Compose controls`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'worklog-docker-target-'))
    try {
      // Never call Docker with the remote sentinels, even in the RED test.
      writeFileSync(join(temp, 'docker'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2), env:process.env}))\n`, { mode: 0o755 })
      const sentinels = {
        DOCKER_HOST: 'tcp://sentinel.invalid:2376', DOCKER_CONTEXT: 'sentinel-production',
        DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/sentinel/certs', DOCKER_CONFIG: '/sentinel/config',
        DOCKER_API_VERSION: '0.0', COMPOSE_FILE: '/sentinel/compose.yml',
        COMPOSE_ENV_FILES: '/sentinel/environment', COMPOSE_PROJECT_NAME: 'sentinel-production',
        COMPOSE_PROFILES: 'sentinel', COMPOSE_PROJECT_DIRECTORY: '/sentinel/project',
      }
      const result = spawnSync(command, args, {
        cwd: import.meta.dirname,
        env: { ...process.env, ...sentinels, E2E_PROJECT: 'worklog-e2e-organisations', PATH: `${temp}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      const invocation = JSON.parse(result.stdout)
      assert.deepEqual(invocation.args.slice(0, 3), ['--host', 'unix:///var/run/docker.sock', 'compose'])
      for (const key of Object.keys(sentinels)) assert.equal(invocation.env[key], undefined, `${key} escaped sanitation`)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })
}

for (const script of ['stack-up.sh', 'stack-down.sh', '../deploy/verify-setup.sh', '../deploy/verify-localhost.sh']) {
  test(`${script} rejects a non-test project before invoking Docker`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'worklog-stack-safety-'))
    try {
      writeFileSync(join(temp, 'docker'), '#!/bin/sh\ntouch "$CALL_MARKER"\nexit 1\n', { mode: 0o755 })
      const result = spawnSync('bash', [script], {
        cwd: import.meta.dirname,
        env: { ...process.env, E2E_PROJECT: 'worklog-orgs-development', PATH: `${temp}:${process.env.PATH}`, CALL_MARKER: join(temp, 'called') },
        encoding: 'utf8',
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Refusing non-test project/)
      assert.equal(existsSync(join(temp, 'called')), false)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })
}
