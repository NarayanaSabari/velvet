import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { ErrorNote } from '../../ui/ErrorNote'
import { useState } from 'react'
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import { Badge } from '@astryxdesign/core/Badge'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { List, ListItem } from '@astryxdesign/core/List'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { Text } from '@astryxdesign/core/Text'

import { api } from '../../lib/api'
import type { Role, WorkspaceMembership } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { clearPrivateQueries, navigateTo, refreshPrivateQueries } from '../auth/sessionNavigation'
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES } from './roles'
import { SelectField } from '../../ui/fields'

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
    <section aria-label="Members">
      {members.data ? <p className="mb-1 text-sm text-grey-700" data-testid="member-counts">{counts}</p> : null}
      <div className="mb-3 max-w-[46rem]">
        <Collapsible defaultIsOpen={false} chevronPosition="start" trigger={<span className="py-1.5"><Text color="secondary">What each role can do</Text></span>}>
          <div className="pt-2 pb-1">
            <MetadataList label={{ position: 'start', width: '6rem' }}>
              {ROLES.map((role) => (
                <MetadataListItem key={role} label={ROLE_LABELS[role]}>{ROLE_DESCRIPTIONS[role]}</MetadataListItem>
              ))}
            </MetadataList>
          </div>
        </Collapsible>
      </div>

      {members.isPending ? <LoadingState label="Loading members…" /> : null}
      {members.error ? (
        <ErrorState message="Could not load members." onRetry={() => void members.refetch()} retrying={members.isRefetching} />
      ) : null}
      {updateRole.error ? <ErrorNote className="mb-2">{updateRole.error.message}</ErrorNote> : null}
      {remove.error ? <ErrorNote className="mb-2">{remove.error.message}</ErrorNote> : null}

      {list.length > 0 ? (
        <div className="border-y border-grey-200">
        <List hasDividers density="balanced" edge="flush" aria-label="Members">
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
              <ListItem key={membership.id} itemKey={membership.id} data-testid={`member-${membership.id}`} label={(
                <div className="py-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                    <Avatar user={membership.user} size="lg" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <Text weight="medium" className="break-words [overflow-wrap:anywhere]">{label}</Text>
                        {isSelf ? <Badge label="You" /> : null}
                      </div>
                      {secondary ? <div className="text-xs text-grey-500 [overflow-wrap:anywhere]">{secondary}</div> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <SelectField
                      label={`Role for ${label}`}
                      hideLabel
                      value={membership.role}
                      title={ROLE_DESCRIPTIONS[membership.role]}
                      disabled={updateRole.isPending || remove.isPending}
                      onChange={(value) => { remove.reset(); updateRole.mutate({ id: membership.id, role: value as Role }) }}
                      options={ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
                    />
                    <Button
                      variant="danger"
                      data-confirm-trigger
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
                {lastAdmin ? (
                  <p className="mt-1 text-xs text-grey-700 sm:pl-11">
                    {list.length > 1
                      ? 'The only admin. Make someone else an admin before changing this role or removing them.'
                      : 'The only member and admin. An organisation needs at least one admin, so this cannot be removed.'}
                  </p>
                ) : null}
                <ConfirmDialog
                  open={removing?.id === membership.id}
                  onClose={() => { remove.reset(); setRemoving(null) }}
                  title={isSelf ? 'Leave this organisation?' : `Remove ${label} from this organisation?`}
                  description={isSelf
                    ? 'You will lose access to this organisation straight away. Your authored work remains.'
                    : 'They will lose access to this organisation. Their authored work remains.'}
                  actionLabel={isSelf ? 'Confirm leave' : 'Confirm removal'}
                  pending={remove.isPending}
                  error={remove.error ? `${remove.error.message} Try again, or cancel.` : null}
                  onConfirm={() => remove.mutate(membership)}
                />
                </div>
              )} />
            )
          })}
        </List>
        </div>
      ) : null}
    </section>
  )
}
