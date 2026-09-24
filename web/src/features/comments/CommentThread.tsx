import { useState, type FormEvent } from 'react'

import type { Comment } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Avatar } from '../../ui/Avatar'
import { Markdown } from '../../ui/Markdown'
import { RelativeTime } from '../../ui/RelativeTime'
import { EmptyState } from '../../ui/EmptyState'
import { Button } from '../../ui/Button'

function CommentBody({ comment }: { comment: Comment }) {
  return (
    <div className="flex gap-2 py-2 text-sm">
      <Avatar user={comment.author} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-ink">{userLabel(comment.author)}</span>
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
export function ReplyEditor({ commentId, onReply }: {
  commentId: string
  onReply: (commentId: string, body: string) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!body.trim()) return
    setBusy(true)
    setFailed(false)
    try {
      await onReply(commentId, body)
      setBody('')
      setOpen(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        className="mb-2 min-h-7 rounded-[var(--radius-control)] px-2 text-xs text-grey-500 hover:bg-grey-100 hover:text-ink"
        onClick={() => setOpen(true)}
      >
        Reply
      </button>
    )
  }
  return (
    <form className="mb-3 rounded-[var(--radius-surface)] bg-grey-100 p-2" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className="ui-control min-h-9 min-w-0 flex-1 px-2 py-1 text-sm"
          placeholder="Write a reply…" value={body} onChange={(event) => setBody(event.target.value)} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !body.trim()}>{busy ? 'Posting…' : 'Post reply'}</Button>
          <Button type="button" disabled={busy} onClick={() => { setOpen(false); setFailed(false) }}>Cancel</Button>
        </div>
      </div>
      {failed ? (
        <p className="mt-1 text-xs text-blocked" role="alert">
          Could not post reply. Your draft is still here.
        </p>
      ) : null}
    </form>
  )
}

export function CommentThread({ comments, onReply }: {
  comments: Comment[]
  onReply?: (commentId: string, body: string) => Promise<unknown>
}) {
  if (comments.length === 0) {
    return <EmptyState title="No updates yet" message="The first comment starts the log." />
  }
  return (
    <div className="divide-y divide-grey-200 rounded-[var(--radius-surface)] border border-grey-200 px-3">
      {comments.map((comment) => (
        <div key={comment.id}>
          <CommentBody comment={comment} />
          {comment.replies?.length ? (
            <div className="ml-4 border-l-2 border-grey-200 pb-2 pl-4">
              {comment.replies.map((reply) => (
                <CommentBody key={reply.id} comment={reply} />
              ))}
            </div>
          ) : null}
          {onReply ? <ReplyEditor commentId={comment.id} onReply={onReply} /> : null}
        </div>
      ))}
    </div>
  )
}
