import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { api, ApiError } from '../../lib/api'
import type { Membership, SessionPayload, User } from '../../lib/types'

export interface Session {
  user: User | null
  memberships: Membership[]
  workspace: Membership | null
  isLoading: boolean
  isSignedIn: boolean
  error: ApiError | null
}

export function landingWorkspace(session?: SessionPayload | null): Membership | null {
  const remembered = session?.last_workspace
  return session?.memberships.find((member) => member.id === remembered?.id && member.workspace_id === remembered.workspace_id)
    ?? session?.memberships[0] ?? null
}

export function sessionQueryOptions(client: QueryClient) {
  return queryOptions({
    queryKey: ['session'],
    queryFn: async () => {
      const previous = client.getQueryData<SessionPayload | null>(['session'])
      const session = await api.get<SessionPayload>('/me').catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) return null
        throw error
      })
      if (previous?.user.id && previous.user.id !== session?.user.id) {
        // Keep this request alive while preventing old private requests from repopulating the cache.
        const privateQueries = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== 'session' }
        await client.cancelQueries(privateQueries)
        client.removeQueries(privateQueries)
        client.getMutationCache().clear()
      }
      return session
    },
    // A 401 is a normal signed-out state, not a fault worth retrying.
    retry: false,
    staleTime: 60_000,
  })
}

export function useSession(slug?: string): Session {
  const client = useQueryClient()
  const query = useQuery(sessionQueryOptions(client))

  const memberships = query.data?.memberships ?? []
  const workspace = slug
    ? memberships.find((m) => m.workspace_slug === slug) ?? null
    : landingWorkspace(query.data)
  const error = query.error instanceof ApiError ? query.error : null

  return {
    user: query.data?.user ?? null,
    memberships,
    workspace,
    isLoading: query.isPending,
    isSignedIn: Boolean(query.data?.user),
    error,
  }
}
