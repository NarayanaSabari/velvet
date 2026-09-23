import { useState, type KeyboardEvent } from 'react'

import { Button } from '../../ui/Button'

export function CommentComposer({
  onSubmit,
  placeholder = 'Write an update…',
}: {
  onSubmit: (body: string) => void | Promise<unknown>
  placeholder?: string
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function submit() {
    if (!body.trim() || busy) return
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit(body)
      // Clearing only after the submission resolves is what stops a network
      // hiccup from destroying someone's long update.
      setBody('')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="mt-3">
      <textarea
        className="ui-control w-full px-3 py-2 text-sm"
        rows={3}
        value={body}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="mt-1 flex items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          Comment
        </Button>
        <span className="text-xs text-grey-500">⌘↵ to post</span>
        {failed ? (
          <span className="text-xs text-blocked">
            Could not post. Your draft is still here - try again.
          </span>
        ) : null}
      </div>
    </div>
  )
}
