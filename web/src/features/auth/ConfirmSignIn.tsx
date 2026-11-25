import { LoadingState } from '../../ui/QueryState'
import { ErrorNote } from '../../ui/ErrorNote'
import { Text } from '@astryxdesign/core/Text'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { Button } from '../../ui/Button'
import { clearFragment, clearPrivateQueries, fragmentToken, navigateTo, safeSignInNext } from './sessionNavigation'
import { Expired } from './Expired'
import { PublicAuthPage } from './PublicAuthPage'

export function ConfirmSignIn({ navigate = navigateTo }: { navigate?: (to: string) => void }) {
  const [token] = useState(fragmentToken)
  const client = useQueryClient()
  const confirm = useMutation({
    mutationFn: () => api.post<{ next: string }>('/auth/magic', { token }),
    onSuccess: async ({ next }) => {
      clearFragment()
      await clearPrivateQueries(client)
      navigate(safeSignInNext(next))
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 410) navigate('/expired')
    },
  })
  if (!token) return <Expired />

  return (
    <PublicAuthPage
      title="Confirm sign-in"
      lead="You opened a sign-in link. Choose Sign in to finish on this device."
    >
      <div className="space-y-4">
        <Button className="min-h-12 w-full" variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>{confirm.isPending ? 'Signing in…' : 'Sign in'}</Button>
        {confirm.isPending ? <LoadingState className="">Signing in…</LoadingState> : null}
        {confirm.error
          ? <ErrorNote>{confirm.error.message}</ErrorNote>
          : <Text as="p" type="supporting" color="secondary" display="block">Didn’t ask for this? Close this page and nothing happens.</Text>}
      </div>
    </PublicAuthPage>
  )
}
