import type { ReactNode } from 'react'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'

/**
 * A create form, opened over the page in an Astryx dialog so the page behind
 * keeps its place. The title names the dialog, the description says in one
 * line what the form makes, and the header's close button, Escape and the
 * form's own success all close it. Mount it only while it is open.
 */
export function FormDialog({ title, description, onClose, width = '36rem', children }: {
  title: string
  description?: string
  onClose: () => void
  /** The preferred width; the dialog never grows past the screen. */
  width?: string
  children: ReactNode
}) {
  const onOpenChange = (isOpen: boolean) => {
    if (!isOpen) onClose()
  }
  return (
    <Dialog
      isOpen
      onOpenChange={onOpenChange}
      // A form: a stray click on the backdrop does not throw away typing.
      purpose="form"
      width={`min(${width}, calc(100vw - 1.5rem))`}
      maxHeight="90dvh"
      padding={0}
    >
      <DialogHeader title={title} subtitle={description} onOpenChange={onOpenChange} />
      <div className="overflow-y-auto p-4" data-testid="form-dialog">{children}</div>
    </Dialog>
  )
}
