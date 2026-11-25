import { Badge } from '@astryxdesign/core/Badge'

import type { IssueStatus } from '../lib/types'

const LABELS: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
}

// Colour appears only on `done`, and never as the sole signal: the label text
// carries the status on its own.
export function StatusBadge({ status }: { status: IssueStatus }) {
  return <Badge variant={status === 'done' ? 'success' : 'neutral'} label={LABELS[status]} />
}

export { LABELS as STATUS_LABELS }
