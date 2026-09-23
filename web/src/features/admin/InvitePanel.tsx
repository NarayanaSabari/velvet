import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { Invitation, Role } from '../../lib/types'
import { Button } from '../../ui/Button'

const roles: Role[] = ['admin', 'member', 'viewer']

export function InvitePanel({ slug }: { slug: string }) {
  const client = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const invites = useQuery({
    queryKey: ['invites', slug],
    queryFn: () => api.get<{ invites: Invitation[] }>(`/w/${slug}/invites`),
  })
  const refresh = () => client.invalidateQueries({ queryKey: ['invites', slug] })
  const create = useMutation({
    mutationFn: () => api.post<Invitation>(`/w/${slug}/invites`, { email: email.trim(), role }),
    onSuccess: async () => { setEmail(''); setRole('member'); await refresh() },
  })
  const resend = useMutation({
    mutationFn: (id: string) => api.post<Invitation>(`/w/${slug}/invites/${id}/resend`),
    onSuccess: refresh,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/w/${slug}/invites/${id}`),
    onSuccess: async () => {
      setConfirmingId(null)
      await refresh()
    },
  })
  const busy = create.isPending || resend.isPending || revoke.isPending
  const error = create.error ?? resend.error ?? revoke.error
  return <section className="mb-8" aria-labelledby="invites-heading">
    <h2 id="invites-heading" className="mb-3 border-b border-grey-200 pb-1 text-base">Invitations</h2>
    <form className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]" onSubmit={(event) => { event.preventDefault(); resend.reset(); revoke.reset(); create.mutate() }}>
      <label>
        <span className="mb-0.5 block text-xs text-grey-500">Invite email</span>
        <input className="w-full border border-grey-300 bg-paper px-2 py-1" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <label>
        <span className="mb-0.5 block text-xs text-grey-500">Invite role</span>
        <select className="w-full border border-grey-300 bg-paper px-2 py-1" value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {roles.map((value) => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}
        </select>
      </label>
      <Button className="self-end" variant="primary" type="submit" disabled={busy || !email.trim()}>{create.isPending ? 'Inviting…' : 'Send invite'}</Button>
    </form>
    {error ? <p role="alert" className="mb-2 text-blocked">{error.message}</p> : null}
    {invites.error ? <p role="alert" className="text-blocked">Could not load invitations.</p> : null}
    {invites.isPending ? <p>Loading invitations…</p> : null}
    {invites.data?.invites.length === 0 ? <p className="text-grey-500">No pending invitations.</p> : null}
    <ul>{invites.data?.invites.map((invite) => <li key={invite.id} className="border-b border-grey-200 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 break-all">{invite.email} <span className="text-grey-500">({invite.role})</span></span>
        <Button aria-label={`Resend invitation to ${invite.email}`} disabled={busy} onClick={() => { create.reset(); revoke.reset(); resend.mutate(invite.id) }}>Resend</Button>
        <Button variant="danger" aria-label={`Revoke invitation to ${invite.email}`} disabled={busy} onClick={() => { create.reset(); resend.reset(); revoke.reset(); setConfirmingId(invite.id) }}>Revoke</Button>
      </div>
      {confirmingId === invite.id ? <div className="mt-2 space-y-2">
        <p className="text-sm text-grey-500">{invite.email} will no longer be able to join this organisation with this invitation.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" disabled={busy} onClick={() => revoke.mutate(invite.id)}>
            {revoke.isPending ? 'Revoking…' : 'Confirm revoke invitation'}
          </Button>
          <Button disabled={busy} onClick={() => setConfirmingId(null)}>Cancel</Button>
        </div>
      </div> : null}
    </li>)}</ul>
  </section>
}
