import { LoadingState } from '../../ui/QueryState'
import { ErrorNote } from '../../ui/ErrorNote'
import { Text } from '@astryxdesign/core/Text'

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

const ROLE_WORDS: Record<string, string> = { admin: 'an admin', member: 'a member', viewer: 'a viewer' }

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

  const wrongAccount = Boolean(preview?.signed_in && !preview.email_matches)
  return (
    <PublicAuthPage
      title={preview ? `Join ${preview.invite.workspace_name}` : 'Organisation invitation'}
      lead={preview ? `You have been invited as ${ROLE_WORDS[preview.invite.role] ?? preview.invite.role}.` : undefined}
    >
      <div className="space-y-4 [overflow-wrap:anywhere]">
        {previewQuery.isFetching ? <LoadingState className="">Loading invitation…</LoadingState> : null}
        {previewQuery.error && !previewQuery.isFetching ? <>
          <ErrorNote>{previewQuery.error.message}</ErrorNote>
          <Button className="min-h-12 w-full" disabled={previewQuery.isFetching} onClick={() => { accept.reset(); void previewQuery.refetch() }}>Retry invitation</Button>
        </> : null}
        {preview ? <>
          {/* Who the invitation is for, set apart so a wrong address is noticed before accepting. */}
          <div className="border-y border-grey-200 py-4">
            <Text as="p" type="supporting" color="secondary" display="block">Invitation for</Text>
            <Text as="p" weight="semibold" display="block" className="mt-0.5">{preview.invite.email}</Text>
          </div>
          {wrongAccount ? <>
            <Text as="p" color="secondary" display="block">You are signed in with a different email. Sign out, then open the invitation again with the invited address.</Text>
            <SignOutButton publicStyle navigate={() => { window.location.reload() }} />
          </> : <Button className="min-h-12 w-full" variant="primary" disabled={accept.isPending || previewQuery.isFetching} onClick={() => { accept.reset(); accept.mutate() }}>
            {accept.isPending ? 'Continuing…' : preview.signed_in ? 'Accept invitation' : 'Sign in and accept'}
          </Button>}
          {!wrongAccount && !preview.signed_in && !accept.error ? (
            <Text as="p" type="supporting" color="secondary" display="block">We’ll email a sign-in link to that address. Accepting finishes when you open it.</Text>
          ) : null}
        </> : null}
        {accept.isPending ? <LoadingState className="">Continuing with your invitation…</LoadingState> : null}
        {accept.error ? <ErrorNote>{accept.error.message}</ErrorNote> : null}
      </div>
    </PublicAuthPage>
  )
}
