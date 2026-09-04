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
      void queryClient.invalidateQueries({ queryKey: ['activity', slug] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard', slug] })
    }
    source.addEventListener('activity', onActivity)

    return () => {
      source.removeEventListener('activity', onActivity)
      source.close()
    }
  }, [slug, queryClient])
}
