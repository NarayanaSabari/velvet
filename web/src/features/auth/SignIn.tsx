import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { navigateTo } from './sessionNavigation'

export function SignIn({ message, navigate = navigateTo }: { message?: string; navigate?: (to: string) => void }) {
  const [email, setEmail] = useState('')
  const request = useMutation({
    mutationFn: () => api.post('/auth/email', { email: email.trim() }),
    onSuccess: () => navigate('/check-email'),
  })
  return (
    <div className="mx-auto mt-24 max-w-sm border border-grey-200 px-6 py-8">
      <h1 className="text-lg">Work log</h1>
      <p className="mt-2 text-sm text-grey-500">
        {message ?? 'Sign in to see your sprints, milestones, and issues.'}
      </p>
      <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); request.mutate() }}>
        <label className="block">Email
          <input className="mt-1 block w-full border border-grey-300 bg-paper px-2 py-1" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <Button variant="primary" type="submit" disabled={request.isPending || !email.trim()}>{request.isPending ? 'Sending…' : 'Send sign-in link'}</Button>
        {request.error ? <p role="alert" className="text-blocked">{request.error.message}</p> : null}
      </form>
    </div>
  )
}
