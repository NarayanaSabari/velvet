import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { Wordmark } from '../../ui/Wordmark'
import { NavLink } from '../../app/nav'
import { navigateTo } from './sessionNavigation'

export function SignIn({ message, navigate = navigateTo }: { message?: string; navigate?: (to: string) => void }) {
  const [email, setEmail] = useState('')
  const emailId = useId()
  const request = useMutation({
    mutationFn: () => api.post('/auth/email', { email: email.trim() }),
    onSuccess: () => navigate('/check-email'),
  })
  return (
    <div className="flex min-h-dvh flex-col bg-paper text-ink">
      <header className="border-b border-grey-200">
        <div className="mx-auto flex min-h-[68px] max-w-[80rem] items-center justify-between gap-4 px-3 sm:px-6">
          <NavLink to="/" className="inline-flex min-h-11 items-center rounded-[var(--radius-control)]"><Wordmark /></NavLink>
          <NavLink to="/" className="inline-flex min-h-11 items-center text-xs text-grey-700 underline-offset-4 hover:underline">About Velvet</NavLink>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[80rem] flex-1 items-center px-3 py-6 sm:px-6 sm:py-8">
        <div className="grid w-full overflow-hidden rounded-[var(--radius-surface)] border border-grey-200 lg:min-h-[34rem] lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <aside className="flex flex-col justify-between gap-8 bg-ink p-6 text-paper sm:p-8 lg:p-10">
            <div>
              <p className="max-w-[12ch] text-lg font-semibold tracking-[-0.035em] sm:text-[2rem] sm:leading-tight lg:text-[3rem] lg:leading-[1.05]">
                Every project. One work record.
              </p>
              <p className="mt-3 max-w-[30ch] text-xs text-paper/80 lg:mt-6 lg:text-sm">
                Pick up where you left off, across every organisation you work with.
              </p>
            </div>
            <div className="hidden border-t border-paper/25 pt-6 lg:block">
              <p className="text-sm font-medium">Less remembering. More doing.</p>
              <p className="mt-2 max-w-[30ch] text-xs text-paper/80">Your notes, agent progress, and GitHub evidence stay together.</p>
            </div>
          </aside>

          <section aria-labelledby="signin-title" className="flex items-center px-6 py-8 sm:px-10 sm:py-12 lg:px-16">
            <div className="mx-auto w-full max-w-sm">
              <h1 id="signin-title" className="text-lg font-semibold tracking-[-0.025em]">Sign in to Velvet</h1>
              <p className="mt-3 text-sm text-grey-500">
                {message ?? 'Use your email to continue. No password to remember.'}
              </p>
              <form className="mt-8" aria-busy={request.isPending} onSubmit={(event) => {
                event.preventDefault()
                if (!request.isPending && email.trim()) request.mutate()
              }}>
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
                <p id={`${emailId}-help`} className="mt-3 text-xs text-grey-500">We’ll email you a sign-in link. It expires in 15 minutes.</p>
                <Button className="mt-6 min-h-12 w-full px-4" variant="primary" type="submit" disabled={request.isPending || !email.trim()}>
                  {request.isPending ? 'Sending…' : 'Send sign-in link'}
                </Button>
                {request.isPending ? <p role="status" className="mt-3 text-xs text-grey-500">Sending your sign-in link…</p> : null}
                {request.error ? <div role="alert" className="mt-4 rounded-[var(--radius-control)] border border-blocked p-3 text-xs text-blocked">
                  <p>{request.error.message}</p>
                  <p className="mt-1">Your email is still here. You can try again.</p>
                </div> : null}
              </form>
            </div>
          </section>
        </div>
      </main>

      <footer className="mx-auto flex w-full max-w-[80rem] flex-wrap justify-between gap-2 px-3 pb-6 text-xs text-grey-500 sm:px-6">
        <p>Self-hosted. Your work stays yours.</p>
        <p>GitHub is optional, never your sign-in.</p>
      </footer>
    </div>
  )
}
