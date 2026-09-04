import { useInfiniteQuery } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Activity } from '../../lib/types'

export interface ActivityFilters {
  actor_id?: string
  verb?: string
  target_type?: string
  target_id?: string
}

interface ActivityPage {
  activity: Activity[]
  next_cursor: string | null
}

function queryString(filters: ActivityFilters, cursor: string | null): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value)
  }
  if (cursor) params.set('cursor', cursor)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** The team feed and the dashboard both page on `next_cursor`, so the cursor
 *  never has to be tracked by a component. */
export function useActivity(slug: string, filters: ActivityFilters = {}) {
  return useInfiniteQuery({
    queryKey: ['activity', slug, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<ActivityPage>(`/w/${slug}/activity${queryString(filters, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })
}
