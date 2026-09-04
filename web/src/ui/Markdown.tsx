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
      className="prose-none [&_a]:underline [&_code]:bg-grey-100 [&_code]:px-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
