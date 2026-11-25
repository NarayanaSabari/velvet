import { ErrorNote } from '../../ui/ErrorNote'
import { useRef, useState, type KeyboardEvent } from 'react'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'

import { Button } from '../../ui/Button'
import { TextAreaField } from '../../ui/fields'
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
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SegmentedControl
          label="Comment view"
          value={preview ? 'preview' : 'write'}
          onChange={(next) => setPreview(next === 'preview')}
        >
          <SegmentedControlItem value="write" label="Write" />
          <SegmentedControlItem value="preview" label="Preview" />
        </SegmentedControl>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button variant="ghost" onClick={insertDiagram}>+ Diagram</Button>
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
      </div>
      {/* Hidden, not unmounted, during a preview: the draft keeps its
          selection, so a diagram still lands where the cursor was. */}
      <div hidden={preview}>
        <TextAreaField
          ref={editor}
          label="Comment"
          hideLabel
          description="Markdown and Mermaid diagrams supported."
          rows={4}
          value={body}
          placeholder={placeholder}
          onChange={(next) => {
            draftVersion.current += 1
            setBody(next)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {preview ? (
        <div role="region" aria-label="Comment preview" className="min-h-28 min-w-0 rounded-[var(--radius-control)] border border-grey-200 p-3">
          {body.trim() ? <Markdown source={body} /> : <Text color="secondary">Nothing to preview yet.</Text>}
        </div>
      ) : null}
      {files.length ? (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Images to attach">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <Token label={file.name} onRemove={() => setFiles((current) => current.filter((_, i) => i !== index))} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Commenting…' : 'Comment'}
        </Button>
        <Text type="supporting" color="secondary">{submitShortcut()} to post</Text>
        {failed ? (
          <ErrorNote>
            Could not post. Your draft is still here - try again.
          </ErrorNote>
        ) : null}
        {attachFailed ? (
          <ErrorNote>
            Comment posted, but the images did not upload. They stay listed for your next comment.
          </ErrorNote>
        ) : null}
      </div>
    </div>
  )
}
