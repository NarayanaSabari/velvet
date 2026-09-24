import { NavLink } from '../app/nav'
import { Button } from './Button'

/**
 * Loading and failure copy for a data surface. Loading is announced as a
 * status and failure as an alert, and the retry keeps the page in place rather
 * than sending the person elsewhere to recover.
 */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="ui-surface flex min-h-24 items-center px-4 py-6 text-sm text-grey-500">
      <span className="mr-2 inline-block size-1.5 rounded-full bg-grey-500" aria-hidden="true" />
      {label}
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
    <div className="ui-surface px-4 py-6">
      <p role="alert" className="font-medium text-blocked">
        {message}
      </p>
      {onRetry ? (
        <Button className="mt-3" disabled={retrying} onClick={onRetry}>
          {retrying ? 'Retrying…' : 'Try again'}
        </Button>
      ) : null}
    </div>
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
      <div className="ui-surface max-w-xl px-6 py-8">
        <h1 className="text-lg font-medium tracking-[-0.02em]">{title}</h1>
        <p className="mt-2 text-sm text-grey-700">{message}</p>
        <p className="mt-4 text-sm">
          <NavLink to={backTo} className="underline underline-offset-4">{backLabel}</NavLink>
        </p>
      </div>
    </div>
  )
}
