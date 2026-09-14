import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import { clearPrivateQueries } from './sessionNavigation'

export function SignOutButton({
  navigate = (to) => window.location.assign(to),
}: {
  navigate?: (to: string) => void
}) {
  const queryClient = useQueryClient()
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [failed, setFailed] = useState(false)

  return (
    <div>
      <button
        className="mt-2 inline-block text-grey-500 underline disabled:opacity-50"
        disabled={isSigningOut}
        type="button"
        onClick={async () => {
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
        }}
      >
        Sign out
      </button>
      {failed ? (
        <p className="text-xs text-blocked" role="alert">Could not sign out. Try again.</p>
      ) : null}
    </div>
  )
}
