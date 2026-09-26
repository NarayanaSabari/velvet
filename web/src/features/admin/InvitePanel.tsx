import { useEffect, useId, useState } from 'react'
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Invitation, Role } from '../../lib/types'
import { Button } from '../../ui/Button'
import { SectionHeader } from '../../ui/PageHeader'
import { LoadingState } from '../../ui/QueryState'
import { RelativeTime } from '../../ui/RelativeTime'
import { expiresSoon, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES } from './roles'

export function InvitePanel({ slug, invites }: {
  slug: string
  invites: UseQueryResult<{ invites: Invitation[] }>
}) {
  const client = useQueryClient()
  const roleHelpId = useId()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const refresh = () => client.invalidateQueries({ queryKey: ['invites', slug] })
  const create = useMutation({
    mutationFn: () => api.post<Invitation>(`/w/${slug}/invites`, { email: email.trim(), role }),
    onSuccess: async (invite) => {
      setEmail('')
      setRole('member')
      setNotice(`Invitation sent to ${invite.email}.`)
      await refresh()
    },
  })
  const resend = useMutation({
    mutationFn: (id: string) => api.post<Invitation>(`/w/${slug}/invites/${id}/resend`),
    onSuccess: async (invite) => {
      setNotice(`Invitation sent again to ${invite.email}.`)
      await refresh()
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/w/${slug}/invites/${id}`),
    onSuccess: async () => {
      setConfirmingId(null)
      await refresh()
    },
  })

  // A confirmation only needs to be read once, then gets out of the way.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const busy = create.isPending || resend.isPending || revoke.isPending
  const error = create.error ?? resend.error ?? revoke.error
  const pending = invites.data?.invites ?? []
  const startAction = () => { setNotice(null); create.reset(); resend.reset(); revoke.reset() }

  return (
    <section id="invitations" className="mb-10 scroll-mt-4" aria-labelledby="invites-heading">
      <SectionHeader id="invites-heading" title="Invitations" meta={invites.data ? `${pending.length} pending` : undefined} />
      <p className="mb-3 max-w-[46rem] text-sm text-grey-500">Invite someone by email. They join with the chosen role after following the link, which lasts 7 days.</p>

      <form
        className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end"
        onSubmit={(event) => { event.preventDefault(); startAction(); create.mutate() }}
      >
        <label>
          <span className="mb-0.5 block text-xs text-grey-500">Invite email</span>
          <input
            className="ui-control min-h-10 w-full px-2 py-1"
            type="email"
            required
            autoComplete="off"
            placeholder="name@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          <span className="mb-0.5 block text-xs text-grey-500">Invite role</span>
          <select
            className="ui-control min-h-10 w-full px-2 py-1"
            value={role}
            aria-describedby={roleHelpId}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {ROLES.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}
          </select>
        </label>
        <Button className="min-h-10" variant="primary" type="submit" disabled={busy || !email.trim()}>
          {create.isPending ? 'Inviting…' : 'Send invite'}
        </Button>
        <p id={roleHelpId} className="text-xs text-grey-500 sm:col-span-3">{ROLE_LABELS[role]}: {ROLE_DESCRIPTIONS[role]}</p>
      </form>

      <div aria-live="polite">
        {notice ? <p role="status" className="mb-2 text-sm text-done">{notice}</p> : null}
      </div>
      {error ? <p role="alert" className="mb-2 text-sm text-blocked">{error.message}</p> : null}
      {invites.error ? <p role="alert" className="text-sm text-blocked">Could not load invitations.</p> : null}
      {invites.isPending ? <LoadingState label="Loading invitations…" /> : null}
      {invites.data && pending.length === 0 ? <p className="text-sm text-grey-500">No pending invitations.</p> : null}

      {pending.length > 0 ? (
        <ul className="overflow-hidden rounded-[var(--radius-surface)] border border-grey-200">
          {pending.map((invite) => {
            const soon = expiresSoon(invite.expires_at)
            return (
              <li key={invite.id} className="border-t border-grey-200 px-3 py-3 first:border-t-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="break-all">
                      {invite.email}{' '}
                      <span className="text-grey-500">({ROLE_LABELS[invite.role]})</span>
                    </div>
                    <div className={`text-xs ${soon ? 'text-stale' : 'text-grey-500'}`}>
                      {soon ? 'Expires soon, ' : 'Expires '}<RelativeTime iso={invite.expires_at} />
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      className="min-h-10 md:min-h-8"
                      aria-label={resend.isPending && resend.variables === invite.id ? `Resending invitation to ${invite.email}…` : `Resend invitation to ${invite.email}`}
                      disabled={busy}
                      onClick={() => { startAction(); resend.mutate(invite.id) }}
                    >
                      {resend.isPending && resend.variables === invite.id ? 'Resending…' : 'Resend'}
                    </Button>
                    <Button
                      variant="danger"
                      className="min-h-10 md:min-h-8"
                      aria-label={`Revoke invitation to ${invite.email}`}
                      disabled={busy}
                      onClick={() => { startAction(); setConfirmingId(invite.id) }}
                    >
                      Revoke
                    </Button>
                  </div>
                </div>
                {confirmingId === invite.id ? (
                  <div className="mt-3 space-y-2 border-t border-grey-200 pt-3">
                    <p className="text-sm text-grey-500">{invite.email} will no longer be able to join this organisation with this invitation.</p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="danger" disabled={busy} onClick={() => revoke.mutate(invite.id)}>
                        {revoke.isPending ? 'Revoking…' : 'Confirm revoke invitation'}
                      </Button>
                      <Button disabled={busy} onClick={() => setConfirmingId(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
