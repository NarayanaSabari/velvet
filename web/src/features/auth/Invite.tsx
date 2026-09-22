import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import type { Invitation, Membership } from '../../lib/types'
import { Button } from '../../ui/Button'
import { SignOutButton } from './SignOutButton'
import { Expired } from './Expired'
import { PublicAuthPage } from './PublicAuthPage'
import { clearFragment, clearPrivateQueries, fragmentToken, navigateTo } from './sessionNavigation'

type Preview = { invite: Invitation; signed_in: boolean; email_matches: boolean }

export function Invite({ navigate = navigateTo }: { navigate?: (to: string) => void }) {
  const [token] = useState(fragmentToken)
  const client = useQueryClient()
  // Preview is read-only. Accept and mail issuance are exclusively button actions.
  const previewQuery = useQuery({
    queryKey: ['invite-preview', token],
    queryFn: () => api.post<Preview>('/invite/preview', { token }),
    enabled: Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const preview = previewQuery.data
  const accept = useMutation({
    mutationFn: () => api.post<Membership | { status: string }>('/invite/accept', { token }),
    onSuccess: async (result) => {
      clearFragment()
      await clearPrivateQueries(client)
      navigate('workspace_slug' in result ? `/w/${result.workspace_slug}` : '/check-email')
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 410) navigate('/expired')
    },
  })
  if (!token || (previewQuery.error instanceof ApiError && previewQuery.error.status === 410)) return <Expired />
  return <PublicAuthPage title="Organisation invitation">
    <div className="space-y-4 [overflow-wrap:anywhere]">
      {previewQuery.isFetching ? <p role="status">Loading invitation…</p> : null}
      {previewQuery.error && !previewQuery.isFetching ? <>
        <p role="alert" className="text-blocked">{previewQuery.error.message}</p>
        <Button className="min-h-12 w-full" disabled={previewQuery.isFetching} onClick={() => { accept.reset(); void previewQuery.refetch() }}>Retry invitation</Button>
      </> : null}
      {preview ? <>
        <p>Join {preview.invite.workspace_name} as {preview.invite.role}.</p>
        <p>This invitation is for {preview.invite.email}.</p>
        {preview.signed_in && !preview.email_matches ? <>
          <p className="text-grey-500">You are signed in with a different email. Sign out to continue with the invited address.</p>
          <SignOutButton publicStyle navigate={() => { window.location.reload() }} />
        </> : <Button className="min-h-12 w-full" variant="primary" disabled={accept.isPending || previewQuery.isFetching} onClick={() => { accept.reset(); accept.mutate() }}>
          {accept.isPending ? 'Continuing…' : preview.signed_in ? 'Accept invitation' : 'Sign in and accept'}
        </Button>}
      </> : null}
      {accept.isPending ? <p role="status" className="text-grey-500">Continuing with your invitation…</p> : null}
      {accept.error ? <p role="alert" className="text-blocked">{accept.error.message}</p> : null}
    </div>
  </PublicAuthPage>
}
