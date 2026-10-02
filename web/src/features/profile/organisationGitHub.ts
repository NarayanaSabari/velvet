import { queryOptions } from '@tanstack/react-query'
import { api } from '../../lib/api'

export type OrganisationGitHubIdentity = {
  workspace_id: string
  user_id: string
  github_id: number
  github_login: string
  linked_at: string
  source: 'organisation' | 'global'
}

export function organisationGitHubQuery(slug: string) {
  return queryOptions({
    queryKey: ['me', 'github', slug],
    queryFn: async () => {
      const response = await api.get<{ identity: OrganisationGitHubIdentity | null }>(`/w/${slug}/me/github`)
      return response.identity
    },
  })
}
