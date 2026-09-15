import { ISSUE_STATUSES, type IssueStatus, type VelvetConfig } from './types.js'

const REQUIRED_VARIABLES = ['VELVET_URL', 'VELVET_TOKEN', 'VELVET_WORKSPACE'] as const

export class ConfigError extends Error {
  readonly missing: readonly string[]

  constructor(message: string, missing: readonly string[] = []) {
    super(message)
    this.name = 'ConfigError'
    this.missing = missing
  }
}

function valueOf(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? ''
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VelvetConfig {
  const missing = REQUIRED_VARIABLES.filter((key) => valueOf(env, key) === '')
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in the server environment, for example with envkit.',
      missing,
    )
  }

  const rawUrl = valueOf(env, 'VELVET_URL')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    throw new ConfigError('VELVET_URL must be a valid URL starting with http:// or https://.')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ConfigError('VELVET_URL must start with http:// or https://.')
  }
  if (parsedUrl.search || parsedUrl.hash) {
    throw new ConfigError('VELVET_URL must not include a query string or fragment.')
  }
  if (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '') {
    throw new ConfigError('VELVET_URL must be the server URL without /api/v1 or another path.')
  }

  const rawDefaultStatus = valueOf(env, 'VELVET_DEFAULT_STATUS')
  let defaultStatus: IssueStatus | undefined
  if (rawDefaultStatus) {
    if (!ISSUE_STATUSES.includes(rawDefaultStatus as IssueStatus)) {
      throw new ConfigError(
        `VELVET_DEFAULT_STATUS must be one of: ${ISSUE_STATUSES.join(', ')}.`,
      )
    }
    defaultStatus = rawDefaultStatus as IssueStatus
  }

  return {
    baseUrl: rawUrl.replace(/\/+$/, ''),
    token: valueOf(env, 'VELVET_TOKEN'),
    workspace: valueOf(env, 'VELVET_WORKSPACE'),
    ...(defaultStatus ? { defaultStatus } : {}),
  }
}
