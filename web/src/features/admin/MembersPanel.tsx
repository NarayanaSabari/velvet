import { useState } from 'react'
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Role, WorkspaceMembership } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { clearPrivateQueries, navigateTo, refreshPrivateQueries } from '../auth/sessionNavigation'
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES } from './roles'

const ROLE_ORDER: Record<Role, number> = { admin: 0, member: 1, viewer: 2 }

/** Admins first, then by name, with the current person leading their group. */
function sortMembers(members: WorkspaceMembership[], selfId: string | undefined) {
  return [...members].sort((a, b) =>
    ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
    Number(b.user.id === selfId) - Number(a.user.id === selfId) ||
    userLabel(a.user).localeCompare(userLabel(b.user)))
}

export function MembersPanel({ slug, selfId, members }: {
  slug: string
  selfId: string | undefined
  members: UseQueryResult<{ memberships: WorkspaceMembership[] }>
}) {
  const client = useQueryClient()
  const [removing, setRemoving] = useState<WorkspaceMembership | null>(null)
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
      if (membership.user.id === selfId) {
        await clearPrivateQueries(client)
        navigateTo('/')
      } else {
        await refreshPrivateQueries(client)
      }
    },
  })

  const list = sortMembers(members.data?.memberships ?? [], selfId)
  const admins = list.filter((member) => member.role === 'admin').length
  const counts = ROLES.map((role) => [role, list.filter((member) => member.role === role).length] as const)
    .filter(([, count]) => count > 0)
    .map(([role, count]) => `${count} ${ROLE_LABELS[role].toLowerCase()}${count === 1 ? '' : 's'}`)
    .join(', ')

  return (
    <section id="members" className="mb-10 scroll-mt-4" aria-labelledby="members-heading">
      <SectionHeader id="members-heading" title="Members" meta={members.data ? counts : undefined} />
      <p className="mb-3 max-w-[46rem] text-sm text-grey-500">People who can open this organisation, and what they can change.</p>

      <details className="mb-3 text-sm">
        <summary className="inline-flex min-h-8 cursor-pointer items-center text-grey-700 underline underline-offset-4">What each role can do</summary>
        <dl className="mt-2 grid max-w-[46rem] gap-x-4 gap-y-1 sm:grid-cols-[6rem_minmax(0,1fr)]">
          {ROLES.map((role) => (
            <div key={role} className="contents">
              <dt className="font-medium">{ROLE_LABELS[role]}</dt>
              <dd className="mb-1 text-grey-700 sm:mb-0">{ROLE_DESCRIPTIONS[role]}</dd>
            </div>
          ))}
        </dl>
      </details>

      {members.isPending ? <LoadingState label="Loading members…" /> : null}
      {members.error ? (
        <ErrorState message="Could not load members." onRetry={() => void members.refetch()} retrying={members.isRefetching} />
      ) : null}
      {updateRole.error ? <p role="alert" className="mb-2 text-sm text-blocked">{updateRole.error.message}</p> : null}
      {remove.error ? <p role="alert" className="mb-2 text-sm text-blocked">{remove.error.message}</p> : null}

      {list.length > 0 ? (
        <ul className="overflow-hidden rounded-[var(--radius-surface)] border border-grey-200">
          {list.map((membership) => {
            const label = userLabel(membership.user)
            const isSelf = membership.user.id === selfId
            // The server refuses to leave an organisation without an admin, so
            // say so up front rather than after a failed request.
            const lastAdmin = membership.role === 'admin' && admins <= 1
            const secondary = [
              membership.user.email && membership.user.email !== label ? membership.user.email : null,
              membership.user.github_login && label !== `@${membership.user.github_login}` ? `@${membership.user.github_login}` : null,
            ].filter(Boolean).join(' · ')
            return (
              <li key={membership.id} className="border-t border-grey-200 px-3 py-3 first:border-t-0" data-testid={`member-${membership.id}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                    <Avatar user={membership.user} size="lg" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="break-words [overflow-wrap:anywhere]">{label}</span>
                        {isSelf ? <span className="text-xs text-grey-500">You</span> : null}
                      </div>
                      {secondary ? <div className="text-xs text-grey-500 [overflow-wrap:anywhere]">{secondary}</div> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <label>
                      <span className="sr-only">Role for {label}</span>
                      <select
                        className="ui-control min-h-10 px-2 py-1 text-sm md:min-h-8"
                        value={membership.role}
                        title={ROLE_DESCRIPTIONS[membership.role]}
                        disabled={updateRole.isPending || remove.isPending}
                        onChange={(event) => { remove.reset(); updateRole.mutate({ id: membership.id, role: event.target.value as Role }) }}
                      >
                        {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                      </select>
                    </label>
                    <Button
                      variant="danger"
                      className="min-h-10 md:min-h-8"
                      aria-label={isSelf ? `Leave organisation as ${label}` : `Remove ${label}`}
                      disabled={remove.isPending || updateRole.isPending || lastAdmin}
                      title={lastAdmin ? 'An organisation needs at least one admin. Make someone else an admin first.' : undefined}
                      onClick={() => { remove.reset(); updateRole.reset(); setRemoving(membership) }}
                    >
                      {isSelf ? 'Leave' : 'Remove'}
                    </Button>
                  </div>
                </div>
                {lastAdmin && list.length > 1 ? (
                  <p className="mt-1 text-xs text-grey-500 sm:pl-11">The only admin. Make someone else an admin before changing this role or removing them.</p>
                ) : null}
                {removing?.id === membership.id ? (
                  <div className="mt-3 space-y-2 border-t border-grey-200 pt-3" role="group" aria-label={`Confirm removing ${label}`}>
                    <p className="text-sm">{isSelf ? 'Leave this organisation?' : `Remove ${label} from this organisation?`}</p>
                    <p className="text-sm text-grey-500">
                      {isSelf
                        ? 'You will lose access to this organisation straight away. Your authored work remains.'
                        : 'They will lose access to this organisation. Their authored work remains.'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(removing)}>
                        {remove.isPending ? 'Removing…' : isSelf ? 'Confirm leave' : 'Confirm removal'}
                      </Button>
                      <Button disabled={remove.isPending} onClick={() => setRemoving(null)}>Cancel</Button>
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
