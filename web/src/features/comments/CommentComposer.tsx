import { useId, useRef, useState, type KeyboardEvent } from 'react'

import { Button } from '../../ui/Button'
import { Markdown } from '../../ui/Markdown'

function submitShortcut() {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent
  return /Mac|iPhone|iPad/.test(platform) ? '⌘↵' : 'Ctrl+Enter'
}

export function CommentComposer({
  onSubmit,
  onAttach,
  placeholder = 'Write an update…',
}: {
  onSubmit: (body: string) => void | Promise<unknown>
  /** Uploads screenshots to the comment onSubmit created. Shows "Attach images" when set. */
  onAttach?: (commentId: string, files: File[]) => Promise<unknown>
  placeholder?: string
}) {
  const [body, setBody] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attachFailed, setAttachFailed] = useState(false)
  const [preview, setPreview] = useState(false)
  const editorId = useId()
  const editor = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
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
    setAttachFailed(false)
    let created: unknown
    try {
      created = await onSubmit(body)
      // Clearing only after the submission resolves is what stops a network
      // hiccup from destroying someone's long update.
      if (draftVersion.current === submittedDraftVersion) {
        setBody('')
      }
    } catch {
      setFailed(true)
      setBusy(false)
      return
    }
    const id = (created as { id?: string } | undefined)?.id
    if (onAttach && files.length && id) {
      try {
        await onAttach(id, files)
        setFiles([])
      } catch {
        // The comment is posted, so only the images are kept for a retry.
        setAttachFailed(true)
      }
    }
    setBusy(false)
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
          {onAttach ? (
            <>
              <Button variant="ghost" onClick={() => picker.current?.click()}>+ Images</Button>
              <input
                ref={picker}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                aria-label="Attach images"
                onChange={(e) => {
                  setFiles((current) => [...current, ...Array.from(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
            </>
          ) : null}
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
      {files.length ? (
        <ul className="mt-2 flex flex-wrap gap-2 text-xs" aria-label="Images to attach">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center gap-1 rounded-[var(--radius-control)] border border-grey-200 px-2 py-1">
              <span className="max-w-48 truncate">{file.name}</span>
              <Button variant="ghost" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>×</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <p id={`${editorId}-help`} className="mt-1 text-xs text-grey-500">Markdown and Mermaid diagrams supported.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Commenting…' : 'Comment'}
        </Button>
        <span className="text-xs text-grey-500">{submitShortcut()} to post</span>
        {failed ? (
          <span role="alert" className="text-xs text-blocked">
            Could not post. Your draft is still here - try again.
          </span>
        ) : null}
        {attachFailed ? (
          <span role="alert" className="text-xs text-blocked">
            Comment posted, but the images did not upload. They stay listed for your next comment.
          </span>
        ) : null}
      </div>
    </div>
  )
}
