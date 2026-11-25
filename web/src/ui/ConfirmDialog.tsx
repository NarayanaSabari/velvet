import { useEffect, useState } from 'react'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'

/**
 * The question asked before something is removed, revoked, archived or
 * closed: an Astryx alert dialog over the page. The title asks, the
 * description says what will happen, and the action button repeats the verb.
 * A failure replaces the description, so the reason is read where the
 * decision is being made, and the dialog stays open for another try.
 */
interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  title: string
  description: string
  actionLabel: string
  onConfirm: () => void
  pending?: boolean
  /** Why the last attempt failed, shown in place of the description. */
  error?: string | null
}

export function ConfirmDialog({ open, ...props }: ConfirmDialogProps) {
  // Mounted only while open, so a closed question adds nothing to the page:
  // a list of rows does not carry one hidden dialog each.
  return open ? <OpenConfirmDialog {...props} /> : null
}

function OpenConfirmDialog({ onClose, title, description, actionLabel, onConfirm, pending = false, error }: Omit<ConfirmDialogProps, 'open'>) {
  // The control that asked, read before the dialog takes focus. Focus goes
  // back to it when the dialog leaves, if it is still on the page.
  const [asker] = useState(() => document.activeElement)
  useEffect(() => () => {
    if (asker instanceof HTMLElement && asker.isConnected) asker.focus()
  }, [asker])
  return (
    <AlertDialog
      isOpen
      onOpenChange={(isOpen) => {
        // Escape does not abandon an action that is already in flight.
        if (isOpen || pending) return
        onClose()
      }}
      title={title}
      description={error || description}
      actionLabel={actionLabel}
      isActionLoading={pending}
      onAction={onConfirm}
    />
  )
}
