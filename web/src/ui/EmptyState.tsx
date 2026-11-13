import type { ReactNode } from 'react'

export function EmptyState({
  title,
  message,
  action,
  compact = false,
}: {
  title: string
  message?: string
  action?: ReactNode
  compact?: boolean
}) {
  if (compact) {
    return <p className="text-sm text-grey-700">{title}{action ? <> {action}</> : null}</p>
  }
  return (
    <div className="ui-surface bg-grey-100 px-6 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {message ? <p className="mx-auto mt-1 max-w-md text-sm text-grey-700">{message}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}
