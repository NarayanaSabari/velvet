import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import type { Invitation, Membership } from '../../lib/types'
import { Button } from '../../ui/Button'
import { SignOutButton } from './SignOutButton'
import { Expired } from './Expired'
import { clearFragment, clearPrivateQueries, fragmentToken, navigateTo } from './sessionNavigation'

type Preview = { invite: Invitation; signed_in: boolean; email_matches: boolean }

export function Invite({ navigate = navigateTo }: { navigate?: (to: string) => void }) {
  const [token] = useState(fragmentToken)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const client = useQueryClient()
  // Preview is read-only. Accept and mail issuance are exclusively button actions.
  useEffect(() => {
    if (!token) return
    let current = true
    api.post<Preview>('/invite/preview', { token }).then(
      (data) => { if (current) setPreview(data) },
      (err: Error) => { if (current) setError(err) },
    )
    return () => { current = false }
  }, [token])
  const accept = useMutation({
    mutationFn: () => api.post<Membership | { status: string }>('/invite/accept', { token }),
    onSuccess: async (result) => {
      clearFragment()
      await clearPrivateQueries(client)
      navigate('workspace_slug' in result ? `/w/${result.workspace_slug}` : '/check-email')
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 410) navigate('/expired')
      else setError(err)
    },
  })
  if (!token || (error instanceof ApiError && error.status === 410)) return <Expired />
  return <main className="mx-auto mt-24 max-w-sm space-y-4 border border-grey-200 px-6 py-8">
    <h1 className="text-lg">Organisation invitation</h1>
    {!preview && !error ? <p>Loading invitation…</p> : null}
    {preview ? <>
      <p>Join {preview.invite.workspace_name} as {preview.invite.role}.</p>
      <p>This invitation is for {preview.invite.email}.</p>
      {preview.signed_in && !preview.email_matches ? <>
        <p className="text-grey-500">You are signed in with a different email. Sign out to continue with the invited address.</p>
        <SignOutButton navigate={() => { window.location.reload() }} />
      </> : <Button variant="primary" disabled={accept.isPending} onClick={() => accept.mutate()}>
        {accept.isPending ? 'Continuing…' : preview.signed_in ? 'Accept invitation' : 'Sign in and accept'}
      </Button>}
    </> : null}
    {error ? <p role="alert" className="text-blocked">{error.message}</p> : null}
  </main>
}
