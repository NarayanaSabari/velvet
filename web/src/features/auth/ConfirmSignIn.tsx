import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { Button } from '../../ui/Button'
import { clearFragment, clearPrivateQueries, fragmentToken, navigateTo } from './sessionNavigation'
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
      navigate(next.startsWith('/') && !next.startsWith('//') ? next : '/')
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 410) navigate('/expired')
    },
  })
  if (!token) return <Expired />
  return <PublicAuthPage title="Confirm sign-in">
    <div className="space-y-4">
      <p className="text-grey-500">Sign in to Velvet using the link sent to your email.</p>
      <Button className="min-h-12 w-full" variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>{confirm.isPending ? 'Signing in…' : 'Sign in'}</Button>
      {confirm.isPending ? <p role="status" className="text-grey-500">Signing in…</p> : null}
      {confirm.error ? <p role="alert" className="text-blocked">{confirm.error.message}</p> : null}
    </div>
  </PublicAuthPage>
}
