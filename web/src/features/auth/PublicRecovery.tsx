import { ErrorNote } from '../../ui/ErrorNote'
import { useRouter } from '@tanstack/react-router'
import { Button as LinkButton } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'

import { Button } from '../../ui/Button'
import { PublicAuthPage } from './PublicAuthPage'

export function PublicSessionPending() {
  return (
    <PublicAuthPage title="Opening Velvet">
      <div className="space-y-4">
        <Text as="p" display="block" role="status">Checking your session…</Text>
        <LinkButton href="/signin" label="Sign in" />
      </div>
    </PublicAuthPage>
  )
}

export function PublicSessionError() {
  const router = useRouter()

  return (
    <PublicAuthPage title="Unable to open Velvet">
      <div className="space-y-4">
        <ErrorNote>We could not check your session. Try again, or go to sign in.</ErrorNote>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void router.invalidate()}>Try again</Button>
          <LinkButton href="/signin" label="Sign in" />
        </div>
      </div>
    </PublicAuthPage>
  )
}

export function PublicRecovery() {
  return (
    <PublicAuthPage
      title="GitHub was not connected"
      lead="Something interrupted the connection, most often a session that expired along the way."
    >
      <ol className="space-y-2 border-y border-grey-200 py-4">
        <li><Text color="secondary">1. Sign in again if you were signed out.</Text></li>
        <li><Text color="secondary">2. Start a new connection from your profile or organisation settings. The old link will not work.</Text></li>
      </ol>
      <div className="mt-6 flex flex-wrap gap-2">
        <LinkButton variant="primary" size="lg" href="/" label="Return to Velvet" />
        <LinkButton size="lg" href="/signin" label="Sign in" />
      </div>
    </PublicAuthPage>
  )
}
