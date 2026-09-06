import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Mention } from '../../lib/types'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Markdown } from '../../ui/Markdown'
import { RelativeTime } from '../../ui/RelativeTime'

export function Mentions({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['mentions', slug],
    queryFn: () => api.get<{ mentions: Mention[] }>(`/w/${slug}/mentions`),
  })
  const markRead = useMutation({
    mutationFn: () => api.post<void>(`/w/${slug}/mentions/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mentions', slug] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard', slug] })
    },
  })

  if (query.isPending) return <p className="text-grey-500">Loading…</p>
  if (query.error) return <p className="text-blocked">Could not load mentions.</p>

  const mentions = query.data.mentions
  const unread = mentions.some((mention) => !mention.read_at)
  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg">Mentions</h1>
        {unread ? (
          <Button disabled={markRead.isPending} onClick={() => markRead.mutate()}>
            Mark all read
          </Button>
        ) : null}
      </div>
      {mentions.length === 0 ? (
        <EmptyState title="No mentions" message="Updates that name you appear here." />
      ) : (
        <ul className="divide-y divide-grey-200 border-y border-grey-200">
          {mentions.map(({ comment, read_at: readAt }) => (
            <li key={comment.id} className="py-2 text-sm">
              <div className="flex items-baseline gap-2">
                <span className={readAt ? 'text-grey-500' : 'font-medium'}>
                  {comment.author.github_login}
                </span>
                <RelativeTime iso={comment.created_at} />
                {!readAt ? <span className="text-xs text-stale">Unread</span> : null}
              </div>
              <div className="mt-1"><Markdown source={comment.body} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
