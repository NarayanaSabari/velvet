import { useEffect, useId, useRef, useState } from 'react'

import { Button } from './Button'
import { diagramDocument, renderDiagram } from './mermaid'

export function MermaidDiagram({ source }: { source: string }) {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const [attempt, setAttempt] = useState(0)
  const [rendered, setRendered] = useState<{ source: string; dark: boolean; attempt: number; svg?: string; error?: string }>()
  const result: { svg?: string; error?: string } = rendered?.source === source && rendered.dark === dark && rendered.attempt === attempt ? rendered : {}
  const [view, setView] = useState<'diagram' | 'source'>('diagram')
  const [copied, setCopied] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const expand = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const change = () => setDark(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])

  useEffect(() => {
    let active = true
    void renderDiagram(source, dark).then(
      (svg) => { if (active) setRendered({ source, dark, attempt, svg }) },
      (error: unknown) => {
        if (active) setRendered({ source, dark, attempt, error: error instanceof Error && /^(Diagram is too large|Diagram configuration|External images)/.test(error.message)
          ? error.message : 'Could not render this diagram. Check the Mermaid syntax in Source.' })
      },
    )
    return () => { active = false }
  }, [source, dark, attempt])

  async function copy() {
    try {
      await navigator.clipboard.writeText(source)
      setCopied('Source copied')
    } catch {
      setView('source')
      setCopied('Could not copy. Select and copy the source below.')
    }
  }

  const frame = result.svg ? diagramDocument(result.svg, dark) : undefined
  return (
    <section className="my-3 min-w-0 overflow-hidden rounded-[var(--radius-surface)] border border-grey-200 [&_button]:min-h-11 sm:[&_button]:min-h-9" aria-label="Mermaid diagram">
      <div className="flex flex-wrap items-center justify-between gap-1 border-b border-grey-200 bg-grey-100 p-1.5">
        <div className="flex gap-1" role="group" aria-label="Diagram view">
          <Button variant={view === 'diagram' ? 'secondary' : 'ghost'} aria-pressed={view === 'diagram'} onClick={() => setView('diagram')}>Diagram</Button>
          <Button variant={view === 'source' ? 'secondary' : 'ghost'} aria-pressed={view === 'source'} onClick={() => setView('source')}>Source</Button>
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" onClick={() => void copy()}>Copy source</Button>
          <button ref={expand} type="button" className="ui-button min-h-9 rounded-[var(--radius-control)] px-2 text-xs hover:bg-grey-200 disabled:opacity-40" disabled={!frame} onClick={() => dialog.current?.showModal()}>Expand</button>
        </div>
      </div>
      {view === 'source' ? <pre className="!m-0 !border-0 text-xs"><code>{source}</code></pre> : (
        <div className="min-h-56">
          {!result.svg && !result.error ? <p className="p-4 text-xs text-grey-500" role="status">Rendering diagram…</p> : null}
          {result.error ? <div className="p-4" role="alert"><p className="!mb-2 text-sm text-blocked">{result.error}</p><Button variant="secondary" onClick={() => setView('source')}>View source</Button><Button variant="ghost" onClick={() => setAttempt(attempt + 1)}>Try again</Button></div> : null}
          {frame ? <iframe title="Rendered Mermaid diagram" sandbox="" srcDoc={frame} className="block h-64 w-full border-0" /> : null}
        </div>
      )}
      {copied ? <p className="!m-0 border-t border-grey-200 px-3 py-2 text-xs text-grey-500" role="status">{copied}</p> : null}
      <dialog ref={dialog} aria-labelledby={titleId} onClose={() => expand.current?.focus()} className="m-auto max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-5xl rounded-[var(--radius-surface)] border border-grey-300 bg-paper p-0 text-ink backdrop:bg-black/50">
        <div className="flex items-center justify-between gap-3 border-b border-grey-200 p-3"><h2 id={titleId} className="!m-0 text-sm font-medium">Mermaid diagram</h2><Button variant="secondary" onClick={() => dialog.current?.close()}>Close</Button></div>
        {frame ? <iframe title="Expanded Mermaid diagram" sandbox="" srcDoc={result.svg ? diagramDocument(result.svg, dark, true) : undefined} className="block h-[70dvh] w-full border-0" /> : null}
        <p className="!m-0 border-t border-grey-200 px-3 py-2 text-xs text-grey-500">Press Escape to close. Use Source to read or copy the diagram text.</p>
      </dialog>
    </section>
  )
}
