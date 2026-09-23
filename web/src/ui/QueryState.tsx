import { NavLink } from '../app/nav'
import { Button } from './Button'

/**
 * Loading and failure copy for a data surface. Loading is announced as a
 * status and failure as an alert, and the retry keeps the page in place rather
 * than sending the person elsewhere to recover.
 */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="text-sm text-grey-500">
      {label}
    </p>
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
    <div className="border border-grey-200 px-4 py-6">
      <p role="alert" className="text-sm text-blocked">
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
    <div className="max-w-[80rem]">
      <h1 className="mb-2 text-lg">{title}</h1>
      <p className="text-sm text-grey-700">{message}</p>
      <p className="mt-3 text-sm">
        <NavLink to={backTo} className="underline">{backLabel}</NavLink>
      </p>
    </div>
  )
}
