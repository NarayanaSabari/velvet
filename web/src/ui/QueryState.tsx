import type { ReactNode } from 'react'
import { Button as LinkButton } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Heading } from '@astryxdesign/core/Heading'
import { Spinner } from '@astryxdesign/core/Spinner'
import { Text } from '@astryxdesign/core/Text'

import { Button } from './Button'
import { ErrorNote } from './ErrorNote'

/**
 * Loading and failure copy for a data surface. Loading is announced as a
 * status and failure as an alert, and the retry keeps the page in place rather
 * than sending the person elsewhere to recover.
 */
export function LoadingState({ label = 'Loading…', children, className }: {
  label?: string
  /** The message, where it is more than plain text. Used in place of `label`. */
  children?: ReactNode
  /** Spacing around the line, where the layout needs it. */
  className?: string
}) {
  return (
    // One line on the page, with nothing drawn around it: waiting is not a
    // panel of its own, and it is replaced by whatever arrives.
    <div role="status" className={`flex items-center gap-2 ${className ?? 'py-3'}`}>
      {/* The wrapper is the announced status. Hiding the spinner itself keeps
          Astryx from announcing "Loading" a second time. */}
      <span className="inline-flex shrink-0">
        <Spinner size="sm" shade="subtle" aria-hidden="true" />
      </span>
      <Text color="secondary">{children ?? label}</Text>
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
  retrying = false,
}: {
  message: string
  onRetry?: () => void
  retrying?: boolean
}) {
  return (
    <ErrorNote
      action={onRetry ? (
        <Button disabled={retrying} onClick={onRetry}>
          {retrying ? 'Retrying…' : 'Try again'}
        </Button>
      ) : undefined}
    >
      {message}
    </ErrorNote>
  )
}

/** A record or page that does not exist. Retrying cannot help, so it offers a
 *  way back instead. */
export function NotFoundState({
  title,
  message,
  backTo,
  backLabel,
}: {
  title: string
  message: string
  backTo: string
  backLabel: string
}) {
  return (
    <div className="w-full min-w-0">
      <div className="max-w-xl">
        <Card padding={6}>
          <Heading level={1}>{title}</Heading>
          <Text as="p" color="secondary" display="block" className="mt-2">{message}</Text>
          <div className="mt-5">
            <LinkButton href={backTo} label={backLabel} />
          </div>
        </Card>
      </div>
    </div>
  )
}
