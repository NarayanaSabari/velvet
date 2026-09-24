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
    <div className="ui-surface bg-grey-100 px-6 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {message ? <p className="mx-auto mt-1 max-w-md text-sm text-grey-500">{message}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}
