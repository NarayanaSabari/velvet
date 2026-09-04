import type { ReactNode } from 'react'

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string
  message?: string
  action?: ReactNode
}) {
  return (
    <div className="border border-grey-200 px-4 py-8 text-center">
      <p className="text-ink">{title}</p>
      {message ? <p className="mt-1 text-sm text-grey-500">{message}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}
