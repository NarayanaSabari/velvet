import { Link, useRouter } from '@tanstack/react-router'

import { Button } from '../../ui/Button'
import { buttonClassName } from '../../ui/buttonStyles'
import { PublicAuthPage } from './PublicAuthPage'

export function PublicSessionPending() {
  return (
    <PublicAuthPage title="Opening Velvet" note="">
      <div className="space-y-4">
        <p role="status" className="text-sm text-grey-700">Checking your session…</p>
        <Link to="/signin" className={buttonClassName('secondary', 'inline-flex min-h-11 items-center')}>Sign in</Link>
      </div>
    </PublicAuthPage>
  )
}

export function PublicSessionError() {
  const router = useRouter()

  return (
    <PublicAuthPage title="Unable to open Velvet" note="">
      <div className="space-y-4">
        <p role="alert" className="text-sm text-blocked">We could not check your session. Try again, or go to sign in.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" className="min-h-11" onClick={() => void router.invalidate()}>Try again</Button>
          <Link to="/signin" className={buttonClassName('secondary', 'inline-flex min-h-11 items-center')}>Sign in</Link>
        </div>
      </div>
    </PublicAuthPage>
  )
}

export function PublicRecovery() {
  return (
    <PublicAuthPage title="Could not connect GitHub" note="">
      <div className="space-y-4">
        <p role="alert" className="text-sm text-blocked">We could not finish connecting GitHub to Velvet.</p>
        <p className="text-sm text-grey-700">If your session expired, sign in again. Then start a new connection from your profile or organisation settings instead of reopening the previous link.</p>
        <div className="flex flex-wrap gap-2">
          <Link to="/" className={buttonClassName('primary', 'inline-flex min-h-11 items-center')}>Return to Velvet</Link>
          <Link to="/signin" className={buttonClassName('secondary', 'inline-flex min-h-11 items-center')}>Sign in</Link>
        </div>
      </div>
    </PublicAuthPage>
  )
}
