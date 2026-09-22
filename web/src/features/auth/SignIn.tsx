import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { PublicAuthPage } from './PublicAuthPage'
import { navigateTo } from './sessionNavigation'

export function SignIn({ message, navigate = navigateTo }: { message?: string; navigate?: (to: string) => void }) {
  const [email, setEmail] = useState('')
  const emailId = useId()
  const request = useMutation({
    mutationFn: () => api.post('/auth/email', { email: email.trim() }),
    onSuccess: () => navigate('/check-email'),
  })
  return (
    <PublicAuthPage title="Sign in to Velvet">
      <form aria-busy={request.isPending} onSubmit={(event) => {
        event.preventDefault()
        if (!request.isPending && email.trim()) request.mutate()
      }}>
        <p className="mb-4 text-sm text-grey-700">
          {message ?? 'Enter your email to continue to your work.'}
        </p>
        <label htmlFor={emailId} className="block text-sm font-medium">Email</label>
        <input
          id={emailId}
          name="email"
          className="mt-2 block min-h-12 w-full rounded-[var(--radius-control)] border border-grey-300 bg-paper px-3 py-2 text-sm placeholder:text-grey-500 disabled:opacity-60"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com"
          aria-describedby={`${emailId}-help`}
          required
          disabled={request.isPending}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <p id={`${emailId}-help`} className="mt-2 text-xs text-grey-500">We’ll email you a link that expires in 15 minutes.</p>
        <Button className="mt-4 min-h-12 w-full px-4" variant="primary" type="submit" disabled={request.isPending || !email.trim()}>
          {request.isPending ? 'Sending…' : 'Send sign-in link'}
        </Button>
        {request.isPending ? <p role="status" className="mt-3 text-xs text-grey-500">Sending your sign-in link…</p> : null}
        {request.error ? <p role="alert" className="mt-3 text-xs text-blocked">{request.error.message}</p> : null}
      </form>
    </PublicAuthPage>
  )
}
