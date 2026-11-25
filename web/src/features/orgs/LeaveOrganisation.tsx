import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'

import { ApiError, api } from '../../lib/api'
import { clearPrivateQueries, navigateTo } from '../auth/sessionNavigation'

function useLeave(slug: string, navigate: (to: string) => void) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api.post(`/w/${slug}/leave`),
    onSuccess: async () => { await clearPrivateQueries(client); navigate('/') },
  })
}

function leaveErrorMessage(error: Error): string {
  return error instanceof ApiError && error.code === 'last_admin'
    ? 'You are the only admin. Make someone else an admin in Administration, then leave.'
    : error.message
}

/**
 * The confirmation a menu opens before someone leaves an organisation.
 * A failure replaces the description, so the reason is read where the
 * decision is being made.
 */
export function LeaveOrganisationDialog({
  slug,
  isOpen,
  onOpenChange,
  navigate = navigateTo,
}: {
  slug: string
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  navigate?: (to: string) => void
}) {
  const leave = useLeave(slug, navigate)
  return (
    <AlertDialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) leave.reset()
        onOpenChange(open)
      }}
      title={`Leave ${slug}?`}
      description={leave.error ? leaveErrorMessage(leave.error) : 'You will need an invitation to rejoin.'}
      actionLabel="Confirm leave"
      isActionLoading={leave.isPending}
      onAction={() => leave.mutate()}
    />
  )
}
