import { LoadingState } from './QueryState'
import { useEffect, useState } from 'react'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Text } from '@astryxdesign/core/Text'

import { Button } from './Button'
import { ErrorNote } from './ErrorNote'
import { diagramDocument, renderDiagram } from './mermaid'

/**
 * The height a diagram needs at the width it is given, so a wide flowchart
 * is not left adrift in a tall box and a tall sequence is not shrunk into a
 * short one. It is never drawn larger than its own size, and stays between
 * 10rem and 30rem; Expand shows the rest. The 32px is the frame's padding.
 */
function fittedHeight(svg: string): string | undefined {
  const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg)
  const width = Number(box?.[1])
  const height = Number(box?.[2])
  if (!(width > 0) || !(height > 0)) return undefined
  return `clamp(10rem, calc(min(${height}px, (100cqw - 32px) * ${height / width}) + 32px), 30rem)`
}

export function MermaidDiagram({ source }: { source: string }) {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const [attempt, setAttempt] = useState(0)
  const [rendered, setRendered] = useState<{ source: string; dark: boolean; attempt: number; svg?: string; error?: string }>()
  const result: { svg?: string; error?: string } = rendered?.source === source && rendered.dark === dark && rendered.attempt === attempt ? rendered : {}
  const [view, setView] = useState<'diagram' | 'source'>('diagram')
  const [copied, setCopied] = useState('')
  const [expanded, setExpanded] = useState(false)

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
        <SegmentedControl label="Diagram view" value={view} onChange={(next) => setView(next === 'source' ? 'source' : 'diagram')}>
          <SegmentedControlItem value="diagram" label="Diagram" />
          <SegmentedControlItem value="source" label="Source" />
        </SegmentedControl>
        <div className="flex gap-1">
          <Button variant="ghost" onClick={() => void copy()}>Copy source</Button>
          <Button variant="ghost" disabled={!frame} onClick={() => setExpanded(true)}>Expand</Button>
        </div>
      </div>
      {view === 'source' ? <pre className="!m-0 !border-0 text-xs"><code>{source}</code></pre> : (
        <div className="min-h-40 [container-type:inline-size]">
          {!result.svg && !result.error ? <LoadingState className="p-4">Rendering diagram…</LoadingState> : null}
          {result.error ? (
            <div className="p-4">
              <ErrorNote action={<><Button variant="secondary" onClick={() => setView('source')}>View source</Button><Button variant="ghost" onClick={() => setAttempt(attempt + 1)}>Try again</Button></>}>
                {result.error}
              </ErrorNote>
            </div>
          ) : null}
          {frame ? <iframe title="Rendered Mermaid diagram" sandbox="" srcDoc={frame} className="block h-64 w-full border-0" style={{ height: fittedHeight(result.svg ?? '') }} /> : null}
        </div>
      )}
      {copied ? <p className="!m-0 border-t border-grey-200 px-3 py-2 text-xs text-grey-500" role="status">{copied}</p> : null}
      <Dialog isOpen={expanded && Boolean(frame)} onOpenChange={setExpanded} width="min(64rem, calc(100vw - 1.5rem))" maxHeight="90dvh" padding={0}>
        <DialogHeader title="Mermaid diagram" onOpenChange={setExpanded} />
        {result.svg ? <iframe title="Expanded Mermaid diagram" sandbox="" srcDoc={diagramDocument(result.svg, dark, true)} className="block h-[70dvh] w-full border-0" /> : null}
        <div className="border-t border-grey-200 px-3 py-2">
          <Text type="supporting" color="secondary">Press Escape to close. Use Source to read or copy the diagram text.</Text>
        </div>
      </Dialog>
    </section>
  )
}
