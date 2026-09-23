import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Mention } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { NavLink } from '../../app/nav'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Markdown } from '../../ui/Markdown'
import { ErrorState, LoadingState } from '../../ui/QueryState'
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

  if (query.isPending) return <LoadingState />
  if (query.error) {
    return (
      <ErrorState
        message="Could not load mentions."
        onRetry={() => void query.refetch()}
        retrying={query.isRefetching}
      />
    )
  }

  const mentions = query.data.mentions
  const unread = mentions.some((mention) => !mention.read_at)

  function targetHref(mention: Mention) {
    if (mention.comment.target_type === 'issue') {
      return `/w/${slug}/issues/${mention.target_label}`
    }
    if (mention.comment.target_type === 'milestone') {
      return `/w/${slug}/milestones/${mention.comment.target_id}`
    }
    return null
  }

  return (
    <div className="max-w-[80rem]">
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
          {mentions.map((mention) => {
            const { comment, read_at: readAt } = mention
            const href = targetHref(mention)
            return (
              <li key={comment.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className={readAt ? 'text-grey-500' : 'font-medium'}>
                    {userLabel(comment.author)}
                  </span>
                  <RelativeTime iso={comment.created_at} />
                  {href ? (
                    <NavLink to={href} className="underline">
                      {mention.target_label}
                    </NavLink>
                  ) : (
                    <span>{mention.target_label}</span>
                  )}
                  {!readAt ? <span className="text-xs text-grey-700">Unread</span> : null}
                </div>
                <div className="mt-1">
                  <Markdown source={comment.body} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
