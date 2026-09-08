import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import type { Invitation, Membership } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { NavLink } from '../../app/nav'
import { useSession } from '../auth/useSession'
import { SignIn } from '../auth/SignIn'
import { SignOutButton } from '../auth/SignOutButton'
import { clearPrivateQueries, navigateTo } from '../auth/sessionNavigation'

const reservedSlugs = new Set('admin api auth check-email expired invite invites me new orgs settings signin signout w webhooks'.split(' '))

export function NewOrganisation({ navigate = navigateTo }: { navigate?: (to: string) => void }) {
  const session = useSession()
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [prefix, setPrefix] = useState('')
  const invites = useQuery({
    queryKey: ['my-invites'],
    queryFn: () => api.get<{ invites: Invitation[] }>('/me/invites'),
    enabled: session.isSignedIn,
  })
  const enter = async (membership: Membership) => {
    await clearPrivateQueries(client)
    navigate(`/w/${membership.workspace_slug}`)
  }
  const create = useMutation({
    mutationFn: () => api.post<Membership>('/orgs', { name: name.trim(), slug, issue_prefix: prefix }),
    onSuccess: enter,
  })
  const accept = useMutation({
    mutationFn: (id: string) => api.post<Membership>(`/me/invites/${id}/accept`),
    onSuccess: enter,
    onError: (error) => { if (error instanceof ApiError && error.status === 410) navigate('/expired') },
  })
  if (session.isLoading) return <p className="p-4 text-grey-500">Loading…</p>
  if (!session.isSignedIn) return <SignIn />
  const valid = name.trim() && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) && !reservedSlugs.has(slug) && /^[A-Z]{2,6}$/.test(prefix)
  return <main className="mx-auto my-12 max-w-lg space-y-8 px-4">
    <header>
      <h1 className="text-lg">New organisation</h1>
      <p className="mt-2 text-grey-700">{userLabel(session.user)}</p>
      <SignOutButton />
      {session.workspace ? <NavLink className="mt-2 block underline" to={`/w/${session.workspace.workspace_slug}`}>Back to {session.workspace.workspace_name}</NavLink> : null}
    </header>
    <section aria-labelledby="pending-heading">
      <h2 id="pending-heading" className="mb-3 border-b border-grey-200 pb-1 text-base">Pending invitations</h2>
      {invites.isPending ? <p>Loading invitations…</p> : null}
      {invites.error ? <p role="alert" className="text-blocked">Could not load invitations.</p> : null}
      {invites.data?.invites.length === 0 ? <p className="text-grey-500">No pending invitations.</p> : null}
      <ul className="space-y-3">{invites.data?.invites.map((invite) => <li key={invite.id} className="flex items-center justify-between gap-3">
        <span>{invite.workspace_name} <span className="text-grey-500">({invite.role})</span></span>
        <Button aria-label={`Accept ${invite.workspace_name} invitation`} disabled={accept.isPending} onClick={() => accept.mutate(invite.id)}>Accept</Button>
      </li>)}</ul>
      {accept.error ? <p role="alert" className="text-blocked">{accept.error.message}</p> : null}
    </section>
    <section aria-labelledby="create-heading">
      <h2 id="create-heading" className="mb-3 border-b border-grey-200 pb-1 text-base">Create an organisation</h2>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (valid) create.mutate() }}>
        <label className="block">Organisation name
          <input className="mt-1 block w-full border border-grey-300 bg-paper px-2 py-1" required value={name} onChange={(event) => {
            setName(event.target.value)
            if (!slugEdited) setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, ''))
          }} />
        </label>
        <label className="block">Slug
          <input className="mt-1 block w-full border border-grey-300 bg-paper px-2 py-1" required minLength={3} maxLength={40} value={slug} onChange={(event) => { setSlugEdited(true); setSlug(event.target.value) }} aria-describedby="slug-help" />
        </label>
        <p id="slug-help" className="text-xs text-grey-500">3 to 40 lowercase letters, digits or hyphens. Start and end with a letter or digit.</p>
        {reservedSlugs.has(slug) ? <p role="alert" className="text-blocked">This slug is reserved.</p> : null}
        <label className="block">Issue prefix
          <input className="mt-1 block w-full border border-grey-300 bg-paper px-2 py-1" required minLength={2} maxLength={6} pattern="[A-Z]{2,6}" value={prefix} onChange={(event) => setPrefix(event.target.value.toUpperCase())} aria-describedby="prefix-help" />
        </label>
        <p id="prefix-help" className="text-xs text-grey-500">2 to 6 uppercase letters, for example LAB.</p>
        <Button variant="primary" type="submit" disabled={!valid || create.isPending}>{create.isPending ? 'Creating…' : 'Create organisation'}</Button>
        {create.error ? <p role="alert" className="text-blocked">{create.error.message}</p> : null}
      </form>
    </section>
  </main>
}
