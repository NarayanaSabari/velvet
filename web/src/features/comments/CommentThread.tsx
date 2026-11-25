import { ErrorNote } from '../../ui/ErrorNote'
import { useState, type FormEvent } from 'react'

import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'

import type { Comment } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Avatar } from '../../ui/Avatar'
import { Markdown } from '../../ui/Markdown'
import { RelativeTime } from '../../ui/RelativeTime'
import { EmptyState } from '../../ui/EmptyState'
import { Button } from '../../ui/Button'
import { CommentImages } from '../images/CommentImages'
import { TextField } from '../../ui/fields'

function CommentBody({ comment, slug }: { comment: Comment; slug?: string }) {
  return (
    <div className="flex gap-2 py-2 text-sm">
      <Avatar user={comment.author} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Text weight="semibold">{userLabel(comment.author)}</Text>
          <RelativeTime iso={comment.created_at} />
          {comment.edited_at ? <Text type="supporting" color="secondary">edited</Text> : null}
        </div>
        <div className="mt-0.5">
          {comment.deleted_at ? (
            <Text color="secondary">Comment deleted</Text>
          ) : (
            <>
              <Markdown source={comment.body} />
              {slug ? <CommentImages images={comment.images} slug={slug} /> : null}
            </>
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
      <div className="mt-1 -ml-2">
        <Button variant="ghost" onClick={() => setOpen(true)}>Reply</Button>
      </div>
    )
  }
  return (
    <form className="mt-2" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <TextField className="flex-1" label="Reply" hideLabel
          placeholder="Write a reply…" value={body} onChange={setBody} />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || !body.trim()}>{busy ? 'Posting…' : 'Post reply'}</Button>
          <Button type="button" disabled={busy} onClick={() => { setOpen(false); setFailed(false) }}>Cancel</Button>
        </div>
      </div>
      {failed ? (
        <ErrorNote className="mt-1">
          Could not post reply. Your draft is still here.
        </ErrorNote>
      ) : null}
    </form>
  )
}

export function CommentThread({ comments, onReply, slug }: {
  comments: Comment[]
  onReply?: (commentId: string, body: string) => Promise<unknown>
  slug?: string
}) {
  if (comments.length === 0) {
    return <EmptyState title="No updates yet" message="The first comment starts the log." />
  }
  return (
    <div className="border-y border-grey-200">
      <List hasDividers density="balanced" edge="flush" aria-label="Updates">
        {comments.map((comment) => (
          <ListItem
            key={comment.id}
            itemKey={comment.id}
            label={(
              <div className="min-w-0">
                <CommentBody comment={comment} slug={slug} />
                {comment.replies?.length ? (
                  <div className="ml-3 border-l-2 border-grey-200 pl-4">
                    {comment.replies.map((reply) => (
                      <CommentBody key={reply.id} comment={reply} slug={slug} />
                    ))}
                  </div>
                ) : null}
                {onReply ? <div className="ml-8"><ReplyEditor commentId={comment.id} onReply={onReply} /></div> : null}
              </div>
            )}
          />
        ))}
      </List>
    </div>
  )
}
