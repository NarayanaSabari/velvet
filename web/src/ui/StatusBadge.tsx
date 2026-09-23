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
const TONE: Partial<Record<IssueStatus, string>> = {
  done: 'border-done text-done',
}

export function StatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span
      className={`inline-block border px-1 text-xs whitespace-nowrap ${
        TONE[status] ?? 'border-grey-300 bg-grey-100 text-grey-700'
      }`}
    >
      {LABELS[status]}
    </span>
  )
}

export { LABELS as STATUS_LABELS }
