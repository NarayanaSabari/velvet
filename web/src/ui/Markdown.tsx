import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useMemo } from 'react'

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

  return template.innerHTML
}

export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source])
  return (
    <div
      className="markdown max-w-[46rem] min-w-0 [overflow-wrap:anywhere]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
