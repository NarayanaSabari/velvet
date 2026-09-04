import { useQuery } from '@tanstack/react-query'

import { api, ApiError } from '../../lib/api'
import type { Membership, SessionPayload, User } from '../../lib/types'

export interface Session {
  user: User | null
  memberships: Membership[]
  workspace: Membership | null
  isLoading: boolean
  isSignedIn: boolean
  /** True when the login is authenticated but belongs to no workspace. */
  isNotInvited: boolean
  error: ApiError | null
}

export function useSession(slug?: string): Session {
  const query = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionPayload>('/me'),
    // A 401 is a normal signed-out state, not a fault worth retrying.
    retry: false,
    staleTime: 60_000,
  })

  const memberships = query.data?.memberships ?? []
  const workspace =
    (slug ? memberships.find((m) => m.workspace_slug === slug) : undefined) ??
    memberships[0] ??
    null
  const error = query.error instanceof ApiError ? query.error : null

  return {
    user: query.data?.user ?? null,
    memberships,
    workspace,
    isLoading: query.isPending,
    isSignedIn: Boolean(query.data?.user),
    isNotInvited: error?.code === 'not_invited' || error?.status === 403,
    error,
  }
}
