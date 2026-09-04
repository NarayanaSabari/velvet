import type { Comment } from '../../lib/types'
import { Avatar } from '../../ui/Avatar'
import { Markdown } from '../../ui/Markdown'
import { RelativeTime } from '../../ui/RelativeTime'
import { EmptyState } from '../../ui/EmptyState'

function CommentBody({ comment }: { comment: Comment }) {
  return (
    <div className="flex gap-2 py-2 text-sm">
      <Avatar user={comment.author} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-ink">{comment.author?.github_login ?? 'Someone'}</span>
          <RelativeTime iso={comment.created_at} />
          {comment.edited_at ? <span className="text-xs text-grey-500">edited</span> : null}
        </div>
        <div className="mt-0.5">
          {comment.deleted_at ? (
            <span className="text-grey-500 italic">Comment deleted</span>
          ) : (
            <Markdown source={comment.body} />
          )}
        </div>
      </div>
    </div>
  )
}

/** The thread is the work log, read top to bottom as a narrative. */
export function CommentThread({ comments }: { comments: Comment[] }) {
  if (comments.length === 0) {
    return <EmptyState title="No updates yet" message="The first comment starts the log." />
  }
  return (
    <div className="divide-y divide-grey-200 border-y border-grey-200">
      {comments.map((comment) => (
        <div key={comment.id}>
          <CommentBody comment={comment} />
          {comment.replies?.length ? (
            <div className="border-l border-grey-200 pb-2 pl-4">
              {comment.replies.map((reply) => (
                <CommentBody key={reply.id} comment={reply} />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
