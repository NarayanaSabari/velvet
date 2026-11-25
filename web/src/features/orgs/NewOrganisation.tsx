import { LoadingState } from '../../ui/QueryState'
import { ErrorNote } from '../../ui/ErrorNote'
import { useState, type ReactNode } from 'react'
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import type { Invitation, Membership } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { NavLink } from '../../app/nav'
import { useSession } from '../auth/useSession'
import { SignIn } from '../auth/SignIn'
import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'

import { PanelHeading } from '../../ui/PageHeader'
import { AccountBar } from '../auth/AccountBar'
import { PublicAuthPage } from '../auth/PublicAuthPage'
import { SignOutButton } from '../auth/SignOutButton'
import { clearPrivateQueries, navigateTo } from '../auth/sessionNavigation'
import { TextField } from '../../ui/fields'

const reservedSlugs = new Set('admin api auth check-email expired invite invites me new orgs settings signin signout w webhooks'.split(' '))

export function NewOrganisation({ navigate = navigateTo, publicLayout = false }: { navigate?: (to: string) => void; publicLayout?: boolean }) {
  const session = useSession()
  const client = useQueryClient()
  const sessionFetching = useIsFetching({ queryKey: ['session'], exact: true }) > 0
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
  const layout = (children: ReactNode) => publicLayout
    ? <PublicAuthPage title="New organisation" expanded><div className="space-y-8">{children}</div></PublicAuthPage>
    : <main className="mx-auto my-12 max-w-lg space-y-8 px-4">{children}</main>
  const publicControl = publicLayout ? 'min-h-12' : undefined
  // The public sign-up page uses the larger control size.
  const fieldSize = publicLayout ? 'lg' : 'md'
  if (session.isLoading) return publicLayout ? layout(<LoadingState className="">Loading…</LoadingState>) : <LoadingState className="p-4">Loading…</LoadingState>
  if (publicLayout && (session.error || client.getQueryState(['session'])?.status === 'error')) return layout(<div className="space-y-4">
    {!sessionFetching ? <ErrorNote>Could not load your session. Try again.</ErrorNote> : null}
    <Button className={publicControl} disabled={sessionFetching} onClick={() => { void client.refetchQueries({ queryKey: ['session'], exact: true }) }}>{sessionFetching ? 'Retrying…' : 'Retry session'}</Button>
    {sessionFetching ? <LoadingState className="">Loading your session…</LoadingState> : null}
  </div>)
  if (!session.isSignedIn) return <SignIn />
  const valid = name.trim() && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) && !reservedSlugs.has(slug) && /^[A-Z]{2,6}$/.test(prefix)

  if (publicLayout) {
    const pending = invites.data?.invites ?? []
    const invitations = (
      <section aria-labelledby="pending-heading">
        <PanelHeading id="pending-heading">Pending invitations</PanelHeading>
        {invites.isFetching ? <LoadingState className="">Loading invitations…</LoadingState> : null}
        {invites.error && !invites.isFetching ? <>
          <ErrorNote>Could not load invitations.</ErrorNote>
          <Button className="mt-2" disabled={invites.isFetching} onClick={() => { accept.reset(); void invites.refetch() }}>Retry invitations</Button>
        </> : null}
        {invites.data && pending.length === 0 ? <Text as="p" color="secondary" display="block">No pending invitations.</Text> : null}
        {pending.length > 0 ? (
          <div className="border-y border-grey-200">
            <List hasDividers density="balanced" edge="flush" aria-label="Pending invitations">
              {pending.map((invite) => (
                <ListItem
                  key={invite.id}
                  itemKey={invite.id}
                  label={<span className="min-w-0 [overflow-wrap:anywhere]">{invite.workspace_name} <Text color="secondary">({invite.role})</Text></span>}
                  endContent={(
                    <Button aria-label={accept.isPending && accept.variables === invite.id ? `Accepting ${invite.workspace_name} invitation…` : `Accept ${invite.workspace_name} invitation`} disabled={accept.isPending} onClick={() => { accept.reset(); accept.mutate(invite.id) }}>
                      {accept.isPending && accept.variables === invite.id ? 'Accepting…' : 'Accept'}
                    </Button>
                  )}
                />
              ))}
            </List>
          </div>
        ) : null}
        {accept.isPending ? <LoadingState className="mt-2">Accepting invitation…</LoadingState> : null}
        {accept.error ? <ErrorNote className="mt-2">{accept.error.message}</ErrorNote> : null}
      </section>
    )
    return (
      <PublicAuthPage
        title="New organisation"
        expanded
        lead="Create a separate organisation, or join one you have been invited to."
        account={(
          <AccountBar
            user={session.user}
            back={session.workspace ? { href: `/w/${session.workspace.workspace_slug}`, label: `Back to ${session.workspace.workspace_name}` } : undefined}
          />
        )}
      >
        <div className="max-w-[30rem] space-y-10">
          {/* An invitation waiting is most likely why someone is here, so it
              leads. With none, creating leads and the empty note goes last. */}
          {pending.length > 0 ? invitations : null}
          <section aria-labelledby="create-heading">
            <PanelHeading id="create-heading" className="mb-4">Create an organisation</PanelHeading>
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (valid && !create.isPending) create.mutate() }}>
              <TextField label="Organisation name" size="lg" required value={name} onChange={(value) => {
                setName(value)
                if (!slugEdited) setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, ''))
              }} />
              <TextField
                label="Slug"
                description={`Its address: /w/${slug || 'your-slug'}. 3 to 40 lowercase letters, digits or hyphens.`}
                size="lg"
                mono
                required
                minLength={3}
                maxLength={40}
                value={slug}
                onChange={(value) => { setSlugEdited(true); setSlug(value) }}
              />
              {reservedSlugs.has(slug) ? <ErrorNote>This slug is reserved.</ErrorNote> : null}
              <TextField
                className="max-w-[12rem]"
                label="Issue prefix"
                description={`2 to 6 capital letters. Tickets are numbered ${prefix || 'LAB'}-1, ${prefix || 'LAB'}-2…`}
                size="lg"
                mono
                required
                minLength={2}
                maxLength={6}
                pattern="[A-Z]{2,6}"
                value={prefix}
                onChange={(value) => setPrefix(value.toUpperCase())}
              />
              <Button className="min-h-12 w-full" variant="primary" type="submit" disabled={!valid || create.isPending}>{create.isPending ? 'Creating…' : 'Create organisation'}</Button>
              {create.isPending ? <LoadingState className="">Creating organisation…</LoadingState> : null}
              {create.error ? <ErrorNote>{create.error.message}</ErrorNote> : null}
            </form>
          </section>
          {pending.length === 0 ? invitations : null}
        </div>
      </PublicAuthPage>
    )
  }

  return layout(<>
    <header>
      {!publicLayout ? <h1 className="text-lg">New organisation</h1> : null}
      <p className={`mt-2 text-grey-700${publicLayout ? ' [overflow-wrap:anywhere]' : ''}`}>{userLabel(session.user)}</p>
      <SignOutButton publicStyle={publicLayout} />
      {session.workspace ? <NavLink className={`mt-2 block underline${publicLayout ? ' min-h-12 content-center [overflow-wrap:anywhere]' : ''}`} to={`/w/${session.workspace.workspace_slug}`}>Back to {session.workspace.workspace_name}</NavLink> : null}
    </header>
    <section aria-labelledby="pending-heading">
      <h2 id="pending-heading" className="mb-3 border-b border-grey-200 pb-1 text-base">Pending invitations</h2>
      {(publicLayout ? invites.isFetching : invites.isPending) ? <LoadingState className="">Loading invitations…</LoadingState> : null}
      {invites.error && (!publicLayout || !invites.isFetching) ? <>
        <ErrorNote>Could not load invitations.</ErrorNote>
        {publicLayout ? <Button className={publicControl} disabled={invites.isFetching} onClick={() => { accept.reset(); void invites.refetch() }}>Retry invitations</Button> : null}
      </> : null}
      {invites.data?.invites.length === 0 ? <p className="text-grey-500">No pending invitations.</p> : null}
      <ul className="space-y-3">{invites.data?.invites.map((invite) => <li key={invite.id} className={`flex items-center justify-between gap-3${publicLayout ? ' min-w-0' : ''}`}>
        <span className={publicLayout ? 'min-w-0 [overflow-wrap:anywhere]' : undefined}>{invite.workspace_name} <span className="text-grey-500">({invite.role})</span></span>
        <Button className={publicLayout ? 'min-h-12 shrink-0' : undefined} aria-label={accept.isPending && accept.variables === invite.id ? `Accepting ${invite.workspace_name} invitation…` : `Accept ${invite.workspace_name} invitation`} disabled={accept.isPending} onClick={() => { if (publicLayout) accept.reset(); accept.mutate(invite.id) }}>{accept.isPending && accept.variables === invite.id ? 'Accepting…' : 'Accept'}</Button>
      </li>)}</ul>
      {accept.isPending ? <LoadingState className="">Accepting invitation…</LoadingState> : null}
      {accept.error ? <ErrorNote>{accept.error.message}</ErrorNote> : null}
    </section>
    <section aria-labelledby="create-heading">
      <h2 id="create-heading" className="mb-3 border-b border-grey-200 pb-1 text-base">Create an organisation</h2>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (valid && !create.isPending) create.mutate() }}>
        <TextField label="Organisation name" size={fieldSize} required value={name} onChange={(value) => {
          setName(value)
          if (!slugEdited) setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, ''))
        }} />
        <TextField
          label="Slug"
          description="3 to 40 lowercase letters, digits or hyphens. Start and end with a letter or digit."
          size={fieldSize}
          required
          minLength={3}
          maxLength={40}
          value={slug}
          onChange={(value) => { setSlugEdited(true); setSlug(value) }}
        />
        {reservedSlugs.has(slug) ? <ErrorNote>This slug is reserved.</ErrorNote> : null}
        <TextField
          label="Issue prefix"
          description="2 to 6 uppercase letters, for example LAB."
          size={fieldSize}
          required
          minLength={2}
          maxLength={6}
          pattern="[A-Z]{2,6}"
          value={prefix}
          onChange={(value) => setPrefix(value.toUpperCase())}
        />
        <Button className={publicControl} variant="primary" type="submit" disabled={!valid || create.isPending}>{create.isPending ? 'Creating…' : 'Create organisation'}</Button>
        {create.isPending ? <LoadingState className="">Creating organisation…</LoadingState> : null}
        {create.error ? <ErrorNote>{create.error.message}</ErrorNote> : null}
      </form>
    </section>
  </>)
}
