import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { MermaidDiagram } from './MermaidDiagram'

function renderMarkdown(source: string) {
  const sanitized = DOMPurify.sanitize(marked.parse(source, { async: false }) as string)
  const template = document.createElement('template')
  template.innerHTML = sanitized

  for (const checkbox of template.content.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  )) {
    const item = checkbox.closest('li')?.cloneNode(true) as HTMLElement | undefined
    for (const nestedList of item?.querySelectorAll('ul, ol') ?? []) {
      nestedList.remove()
    }
    const task = item?.textContent?.trim() || 'Untitled'
    checkbox.setAttribute(
      'aria-label',
      `${checkbox.checked ? 'Completed' : 'Incomplete'} task: ${task}`,
    )
  }

  // Placeholder attributes belong to this renderer, never to user HTML.
  for (const element of template.content.querySelectorAll('[data-mermaid-index]')) {
    element.removeAttribute('data-mermaid-index')
  }
  const diagrams: string[] = []
  for (const code of template.content.querySelectorAll('pre > code.language-mermaid')) {
    const placeholder = document.createElement('div')
    placeholder.dataset.mermaidIndex = String(diagrams.length)
    diagrams.push(code.textContent ?? '')
    code.parentElement!.replaceWith(placeholder)
  }
  return { html: template.innerHTML, diagrams }
}

function MarkdownContent({ source }: { source: string }) {
  const { html, diagrams } = useMemo(() => renderMarkdown(source), [source])
  const root = useRef<HTMLDivElement>(null)
  const [targets, setTargets] = useState<Element[]>([])
  useLayoutEffect(() => {
    // Set sanitized HTML once. Reapplying dangerouslySetInnerHTML on a portal
    // update would detach the hosts React just populated.
    root.current!.innerHTML = html
    setTargets([...root.current!.querySelectorAll('[data-mermaid-index]')])
  }, [html])
  return (
    <>
      <div ref={root}
        className="markdown w-full max-w-[46rem] min-w-0 [overflow-wrap:anywhere]"
      />
      {targets.map((target, index) => createPortal(<MermaidDiagram source={diagrams[index] ?? ''} />, target, String(index)))}
    </>
  )
}

export function Markdown({ source }: { source: string }) {
  // Remount the portal hosts with the document, never reuse a detached source target.
  return <MarkdownContent key={source} source={source} />
}
