import { LoadingState } from '../../ui/QueryState'
import { ErrorNote } from '../../ui/ErrorNote'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { clearPrivateQueries } from './sessionNavigation'

/** Signing out, for anything that offers it: a button here, a menu row elsewhere. */
export function useSignOut(navigate: (to: string) => void = (to) => window.location.assign(to)) {
  const queryClient = useQueryClient()
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [failed, setFailed] = useState(false)

  async function signOut() {
    setIsSigningOut(true)
    setFailed(false)
    try {
      await api.post('/auth/logout')
      await clearPrivateQueries(queryClient)
      navigate('/signin')
    } catch {
      setFailed(true)
    } finally {
      setIsSigningOut(false)
    }
  }

  return { signOut, isSigningOut, failed }
}

export function SignOutButton({
  navigate,
  publicStyle = false,
}: {
  navigate?: (to: string) => void
  publicStyle?: boolean
}) {
  const { signOut, isSigningOut, failed } = useSignOut(navigate)

  return (
    <div>
      {/* A quiet button: signing out is always available, never the main action. */}
      <Button variant="ghost" disabled={isSigningOut} onClick={() => void signOut()}>
        {publicStyle && isSigningOut ? 'Signing out…' : 'Sign out'}
      </Button>
      {publicStyle && isSigningOut ? <LoadingState className="">Signing out…</LoadingState> : null}
      {failed ? (
        <ErrorNote>Could not sign out. Try again.</ErrorNote>
      ) : null}
    </div>
  )
}
