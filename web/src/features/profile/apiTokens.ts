import { api } from '../../lib/api'

export interface ApiToken {
  kind?: 'personal' | 'project' | 'setup' | 'desktop'
  parent_id?: string | null
  id: string
  name: string
  created_at: string
  last_used_at: string | null
  /** Set for a key made by `velvet init`, which can reach only this project. */
  workspace_slug?: string | null
  project_key?: string | null
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
