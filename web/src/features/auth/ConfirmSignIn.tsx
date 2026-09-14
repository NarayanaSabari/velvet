import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { Button } from '../../ui/Button'
import { clearFragment, clearPrivateQueries, fragmentToken, navigateTo } from './sessionNavigation'
import { Expired } from './Expired'

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
  return <main className="mx-auto mt-24 max-w-sm space-y-4 border border-grey-200 px-6 py-8">
    <h1 className="text-lg">Confirm sign-in</h1>
    <p className="text-grey-500">Sign in to Work log using the link sent to your email.</p>
    <Button variant="primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>{confirm.isPending ? 'Signing in…' : 'Sign in'}</Button>
    {confirm.error ? <p role="alert" className="text-blocked">{confirm.error.message}</p> : null}
  </main>
}
