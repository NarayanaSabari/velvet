import type { ReactNode } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { EmptyState as AstryxEmptyState } from '@astryxdesign/core/EmptyState'

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
  // The compact form is one sentence inside running content, which Astryx's
  // stacked empty state is not, so it stays a plain line.
  if (compact) {
    return (
      <p className="text-sm text-grey-700">
        <span>{title}</span>
        {message ? <> {message}</> : null}
        {action ? <> {action}</> : null}
      </p>
    )
  }
  return (
    // The same Astryx card as the not-found state, so "nothing here" and
    // "not found" read as one family.
    <Card padding={6}>
      <AstryxEmptyState title={title} description={message} actions={action} />
    </Card>
  )
}
