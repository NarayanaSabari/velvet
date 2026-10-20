import { useId, useRef, useState, type KeyboardEvent } from 'react'

import { Button } from '../../ui/Button'
import { Markdown } from '../../ui/Markdown'

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
  const [preview, setPreview] = useState(false)
  const editorId = useId()
  const editor = useRef<HTMLTextAreaElement>(null)
  const draftVersion = useRef(0)

  function insertDiagram() {
    const start = editor.current?.selectionStart ?? body.length
    const end = editor.current?.selectionEnd ?? start
    const before = body.slice(0, start)
    const after = body.slice(end)
    const diagram = `${before && !before.endsWith('\n') ? '\n' : ''}\`\`\`mermaid\nflowchart TD\n  A[Start] --> B[Next step]\n\`\`\`\n`
    draftVersion.current += 1
    setBody(before + diagram + after)
    setPreview(false)
    requestAnimationFrame(() => {
      editor.current?.focus()
      editor.current?.setSelectionRange(start + diagram.length, start + diagram.length)
    })
  }

  async function submit() {
    if (!body.trim() || busy) return
    const submittedDraftVersion = draftVersion.current
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit(body)
      // Clearing only after the submission resolves is what stops a network
      // hiccup from destroying someone's long update.
      if (draftVersion.current === submittedDraftVersion) {
        setBody('')
      }
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
    <div className="mt-3 [&_button]:min-h-11 sm:[&_button]:min-h-9">
      <label htmlFor={editorId} className="mb-1 block text-sm font-medium">Comment</label>
      <div className="min-w-0 rounded-[var(--radius-control)] border border-grey-300 bg-paper">
        <div className="flex flex-wrap items-center gap-1 border-b border-grey-200 p-2">
          <Button variant={preview ? 'ghost' : 'secondary'} aria-pressed={!preview} onClick={() => setPreview(false)}>
            Write
          </Button>
          <Button variant={preview ? 'secondary' : 'ghost'} aria-pressed={preview} onClick={() => setPreview(true)}>
            Preview
          </Button>
          <Button variant="ghost" className="ml-auto" onClick={insertDiagram}>+ Diagram</Button>
        </div>
        <textarea
          ref={editor}
          id={editorId}
          hidden={preview}
          aria-describedby={`${editorId}-help`}
          className="min-h-28 w-full rounded-b-[var(--radius-control)] bg-paper px-3 py-2 text-sm"
          rows={3}
          value={body}
          placeholder={placeholder}
          onChange={(e) => {
            draftVersion.current += 1
            setBody(e.target.value)
          }}
          onKeyDown={onKeyDown}
        />
        {preview ? (
          <div role="region" aria-label="Comment preview" className="min-h-28 min-w-0 p-3">
            {body.trim() ? <Markdown source={body} /> : <p className="text-sm text-grey-500">Nothing to preview yet.</p>}
          </div>
        ) : null}
      </div>
      <p id={`${editorId}-help`} className="mt-1 text-xs text-grey-500">Markdown and Mermaid diagrams supported.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Commenting…' : 'Comment'}
        </Button>
        <span className="text-xs text-grey-500">⌘↵ to post</span>
        {failed ? (
          <span role="alert" className="text-xs text-blocked">
            Could not post. Your draft is still here - try again.
          </span>
        ) : null}
      </div>
    </div>
  )
}
