import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useMemo } from 'react'

export function Markdown({ source }: { source: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false }) as string),
    [source],
  )
  return (
    <div
      className="max-w-[46rem] min-w-0 prose-none [overflow-wrap:anywhere] [&_a]:underline [&_code]:bg-grey-100 [&_code]:px-1 [&_pre]:whitespace-pre-wrap"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
