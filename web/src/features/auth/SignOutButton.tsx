import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import { clearPrivateQueries } from './sessionNavigation'

export function SignOutButton({
  navigate = (to) => window.location.assign(to),
  publicStyle = false,
  menuItem = false,
}: {
  navigate?: (to: string) => void
  publicStyle?: boolean
  menuItem?: boolean
}) {
  const queryClient = useQueryClient()
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [failed, setFailed] = useState(false)

  return (
    <div role={menuItem ? 'none' : undefined}>
      <button
        className={menuItem
          ? 'block w-full rounded-[6px] px-2 py-1.5 text-left text-grey-500 hover:bg-grey-100 focus-visible:bg-grey-100 disabled:opacity-50'
          : `mt-2 inline-block text-grey-500 underline disabled:opacity-50${publicStyle ? ' min-h-12 px-3' : ''}`}
        disabled={isSigningOut}
        type="button"
        role={menuItem ? 'menuitem' : undefined}
        tabIndex={menuItem ? -1 : undefined}
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
        {publicStyle && isSigningOut ? 'Signing out…' : 'Sign out'}
      </button>
      {publicStyle && isSigningOut ? <p role="status" className="text-xs text-grey-500">Signing out…</p> : null}
      {failed ? (
        <p className="text-xs text-blocked" role="alert">Could not sign out. Try again.</p>
      ) : null}
    </div>
  )
}
