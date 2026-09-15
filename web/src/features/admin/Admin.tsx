import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useSession } from '../auth/useSession'
import { clearPrivateQueries, navigateTo, refreshPrivateQueries } from '../auth/sessionNavigation'
import { api } from '../../lib/api'
import type { Repo, Role, WorkspaceMembership } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { OrganisationPanel } from './OrganisationPanel'
import { InvitePanel } from './InvitePanel'
import { GitHubPanel } from './GitHubPanel'
import { DangerPanel } from './DangerPanel'

const ROLES: Role[] = ['admin', 'member', 'viewer']

export function Admin({ slug }: { slug: string }) {
  const session = useSession(slug)
  const client = useQueryClient()
  const [removing, setRemoving] = useState<WorkspaceMembership | null>(null)
  const isAdmin = session.workspace?.role === 'admin'
  const members = useQuery({
    queryKey: ['memberships', slug],
    queryFn: () => api.get<{ memberships: WorkspaceMembership[] }>(`/w/${slug}/memberships`),
    enabled: isAdmin,
  })
  const repos = useQuery({
    queryKey: ['repos', slug],
    queryFn: () => api.get<{ repos: Repo[] }>(`/w/${slug}/repos`),
    enabled: isAdmin,
  })
  const updateRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api.patch<WorkspaceMembership>(`/w/${slug}/memberships/${id}`, { role }),
    onSuccess: () => refreshPrivateQueries(client),
    onError: () => client.invalidateQueries({ queryKey: ['memberships', slug] }),
  })
  const remove = useMutation({
    mutationFn: (membership: WorkspaceMembership) => api.del(`/w/${slug}/memberships/${membership.id}`),
    onSuccess: async (_, membership) => {
      setRemoving(null)
      if (membership.user.id === session.user?.id) {
        await clearPrivateQueries(client)
        navigateTo('/')
      } else {
        await refreshPrivateQueries(client)
      }
    },
  })

  if (session.isLoading) return <p className="text-grey-500">Loading…</p>
  if (!isAdmin) return <EmptyState title="Admin access required" message="Only organisation admins can manage members and repository connections." />

  return (
    <div className="max-w-[80rem]">
      <h1 className="mb-1 text-lg">Administration</h1>
      <p className="mb-6 text-grey-500">Manage who can enter this organisation and which GitHub repositories supply work evidence.</p>
      <OrganisationPanel slug={slug} workspace={session.workspace!} />
      <InvitePanel slug={slug} />
      <section className="mb-8" aria-labelledby="members-heading">
        <h2 id="members-heading" className="mb-3 border-b border-grey-200 pb-1 text-base">Members</h2>
        {members.isPending ? <p className="text-grey-500">Loading members…</p> : null}
        {members.error ? <p role="alert" className="text-blocked">Could not load members.</p> : null}
        {updateRole.error ? <p role="alert" className="text-blocked">{updateRole.error.message}</p> : null}
        {remove.error ? <p role="alert" className="text-blocked">{remove.error.message}</p> : null}
        <ul className="border-t border-grey-200">
          {members.data?.memberships.map((membership) => (
            <li key={membership.id} className="flex flex-wrap items-center gap-3 border-b border-grey-200 px-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate">{userLabel(membership.user)}</div>
                {membership.user.github_login && userLabel(membership.user) !== `@${membership.user.github_login}` ? (
                  <div className="text-xs text-grey-500">@{membership.user.github_login}</div>
                ) : null}
              </div>
              <label>
                <span className="sr-only">Role for {userLabel(membership.user)}</span>
                <select
                  className="border border-grey-300 bg-paper px-2 py-1 text-sm"
                  value={membership.role}
                  disabled={updateRole.isPending || remove.isPending}
                  onChange={(event) => updateRole.mutate({ id: membership.id, role: event.target.value as Role })}
                >
                  {ROLES.map((role) => <option key={role} value={role}>{role.charAt(0).toUpperCase() + role.slice(1)}</option>)}
                </select>
              </label>
              <Button variant="danger" aria-label={`Remove ${userLabel(membership.user)}`} disabled={remove.isPending || updateRole.isPending} onClick={() => { remove.reset(); setRemoving(membership) }}>Remove</Button>
            </li>
          ))}
        </ul>
        {removing ? <div className="mt-3 space-y-2">
          <p>Remove {userLabel(removing.user)} from this organisation?</p>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(removing)}>Confirm removal</Button>{' '}
          <Button disabled={remove.isPending} onClick={() => setRemoving(null)}>Cancel</Button>
        </div> : null}
      </section>
      <GitHubPanel slug={slug} repos={repos.data?.repos ?? []} isLoading={repos.isPending} hasError={Boolean(repos.error)} />
      <DangerPanel slug={slug} />
    </div>
  )
}
