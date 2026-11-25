import { Badge } from '@astryxdesign/core/Badge'
import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Mention } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { NavLink } from '../../app/nav'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Markdown } from '../../ui/Markdown'
import { PageHeader } from '../../ui/PageHeader'
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

  if (query.isPending || query.error) {
    return (
      <div className="w-full min-w-0">
        <PageHeader title="Mentions" description="Comments that need your attention, gathered into one inbox." />
        {query.isPending ? <LoadingState /> : (
          <ErrorState
            message="Could not load mentions."
            onRetry={() => void query.refetch()}
            retrying={query.isRefetching}
          />
        )}
      </div>
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
    <div className="w-full min-w-0">
      <PageHeader
        title="Mentions"
        description="Comments that need your attention, gathered into one inbox."
        actions={unread ? (
          <Button disabled={markRead.isPending} onClick={() => markRead.mutate()}>
            {markRead.isPending ? 'Marking read…' : 'Mark all read'}
          </Button>
        ) : undefined}
      />
      {mentions.length === 0 ? (
        <EmptyState title="No mentions" message="Updates that name you appear here." />
      ) : (
        <div className="border-b border-grey-200">
        <List hasDividers density="balanced" edge="flush" aria-label="Mentions">
          {mentions.map((mention) => {
            const { comment, read_at: readAt } = mention
            const href = targetHref(mention)
            return (
              <ListItem
                key={comment.id}
                itemKey={comment.id}
                align="start"
                // An unread mention leads with a dot and a heavier name; the
                // word Unread beside it says the same without colour.
                startContent={(
                  <span className="flex h-6 w-2 items-center" aria-hidden="true">
                    {!readAt ? <span className="h-2 w-2 rounded-full bg-ink" /> : null}
                  </span>
                )}
                label={(
              <div className="min-w-0 py-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Text weight={readAt ? 'normal' : 'semibold'} color={readAt ? 'secondary' : 'primary'}>
                    {userLabel(comment.author)}
                  </Text>
                  <RelativeTime iso={comment.created_at} />
                  {href ? (
                    <NavLink to={href} className="inline-flex min-h-11 items-center underline sm:min-h-0">
                      {mention.target_label}
                    </NavLink>
                  ) : (
                    <span>{mention.target_label}</span>
                  )}
                  {!readAt ? <Badge label="Unread" /> : null}
                </div>
                <div className="mt-1">
                  <Markdown source={comment.body} />
                </div>
              </div>
                )}
              />
            )
          })}
        </List>
        </div>
      )}
    </div>
  )
}
