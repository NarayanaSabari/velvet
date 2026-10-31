import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

/**
 * Subscribes to the workspace's SSE stream and invalidates caches on each
 * event rather than patching them. The server stays the single source of
 * truth, so a dropped event costs one refresh instead of a wrong screen.
 */
export function useStream(slug: string | undefined) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!slug) return
    if (typeof EventSource === 'undefined') return

    const source = new EventSource(`/api/v1/w/${slug}/stream`)
    const onActivity = () => {
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === slug })
      void queryClient.invalidateQueries({ queryKey: ['worklog'] })
    }
    source.addEventListener('activity', onActivity)
    source.addEventListener('refresh', onActivity)
    // The stream does not replay missed events. Refresh on every successful
    // connection, including reconnection after sleep or a network interruption.
    source.addEventListener('open', onActivity)
    // A brief offline interval can leave EventSource open, so no new `open`
    // event arrives. Fresh query caches still need reconciliation after it.
    window.addEventListener('online', onActivity)

    return () => {
      source.removeEventListener('activity', onActivity)
      source.removeEventListener('refresh', onActivity)
      source.removeEventListener('open', onActivity)
      window.removeEventListener('online', onActivity)
      source.close()
    }
  }, [slug, queryClient])
}
