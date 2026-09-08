import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const port = Number(process.env.E2E_PORT ?? 18399)
const providerPort = Number(process.env.E2E_PROVIDER_PORT ?? 18599)
if (![port, port + 1, providerPort].every((n) => Number.isInteger(n) && n > 1024 && n < 65536)) throw new Error('Invalid test port')
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const values = {
  SITE_ADDRESS: `http://localhost:${port}`, BASE_URL: `http://localhost:${port}`,
  HTTP_PORT: port, HTTPS_PORT: port + 1, CADDY_HTTP_PORT: port, CADDY_HTTPS_PORT: port + 1,
  E2E_PROVIDER_PORT: providerPort,
  IMAGE_REPO: 'worklog-e2e-organisations', IMAGE_TAG: 'test',
  POSTGRES_USER: 'worklog', POSTGRES_PASSWORD: 'e2e-local-only', POSTGRES_DB: 'worklog',
  DATABASE_URL: 'postgres://worklog:e2e-local-only@postgres:5432/worklog?sslmode=disable',
  GITHUB_APP_CLIENT_ID: 'local-github-client', GITHUB_APP_CLIENT_SECRET: 'local-github-secret',
  GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_AUTHORIZATION_URL: `http://localhost:${providerPort}/authorize`,
  GITHUB_INSTALLATION_URL: `http://localhost:${providerPort}/install`,
  GITHUB_TOKEN_URL: 'http://github:18599/token', GITHUB_API_URL: 'http://github:18599',
  GITHUB_WEBHOOK_SECRET: 'e2e-webhook-secret', RESEND_API_KEY: '', MAIL_FROM: '', BACKUP_S3_URL: '',
  PROXY_SUBNET: '172.30.77.0/24', PROXY_CADDY_IP: '172.30.77.2', PROXY_API_IP: '172.30.77.3', PROXY_GITHUB_IP: '172.30.77.4',
}
writeFileSync(new URL('.env.generated', import.meta.url), Object.entries(values).map(([key, value]) => `${key}='${value}'\n`).join(''), { mode: 0o600 })
