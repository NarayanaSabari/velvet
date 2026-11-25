import { LoadingState } from '../../ui/QueryState'
import { ErrorNote } from '../../ui/ErrorNote'
import { Text } from '@astryxdesign/core/Text'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { PublicAuthPage } from './PublicAuthPage'
import { navigateTo, cliReturnTo } from './sessionNavigation'
import { TextField } from '../../ui/fields'

export function SignIn({ message, returnTo, navigate = navigateTo }: { message?: string; returnTo?: string; navigate?: (to: string) => void }) {
  const [email, setEmail] = useState('')
  const request = useMutation({
    mutationFn: () => api.post('/auth/email', { email: email.trim(), ...(cliReturnTo(returnTo) ? { return_to: cliReturnTo(returnTo) } : {}) }),
    onSuccess: () => navigate('/check-email'),
  })
  return (
    <PublicAuthPage
      title="Sign in to Velvet"
      // One line that says the whole deal, in place of three scattered hints.
      lead={message ?? 'Enter your email and we’ll send you a sign-in link. No password needed.'}
    >
      <form aria-busy={request.isPending} className="space-y-4" onSubmit={(event) => {
        event.preventDefault()
        if (!request.isPending && email.trim()) request.mutate()
      }}>
        <TextField
          label="Email"
          name="email"
          size="lg"
          type="email"
          inputMode="email"
          autoComplete="email"
          literal
          placeholder="you@example.com"
          required
          disabled={request.isPending}
          value={email}
          onChange={setEmail}
        />
        <Button className="min-h-12 w-full px-4" variant="primary" type="submit" disabled={request.isPending || !email.trim()}>
          {request.isPending ? 'Sending…' : 'Send sign-in link'}
        </Button>
        {request.isPending ? <LoadingState className="">Sending your sign-in link…</LoadingState> : null}
        {request.error
          ? <ErrorNote>{request.error.message}</ErrorNote>
          : <Text as="p" type="supporting" color="secondary" display="block">The link works once and expires in 15 minutes.</Text>}
      </form>
    </PublicAuthPage>
  )
}
