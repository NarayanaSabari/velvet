import { api, ApiError } from '../../lib/api'

export interface ApiToken {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
}

export interface CreatedApiToken {
  id: string
  name: string
  token: string
}

/** One cache entry for the token list and agent setup, so a key created or
 *  first used in one place shows up in the other without a reload. */
export const apiTokensQuery = {
  queryKey: ['api-tokens'] as const,
  queryFn: () => api.get<{ tokens: ApiToken[] }>('/me/tokens'),
}

/** Each agent setup gets its own key, named so it is recognisable in the
 *  token list and can be revoked without affecting other agents. Names are
 *  unique per person, so a second setup in the same minute gets a number. */
export async function createAgentToken() {
  const base = `Coding agent ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  // A person holds at most 20 keys, so 20 names always leave room for one.
  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? base : `${base} (${attempt})`
    try {
      return await api.post<CreatedApiToken>('/me/tokens', { name })
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'conflict') || attempt >= 20) throw error
    }
  }
}
