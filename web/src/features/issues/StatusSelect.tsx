import type { IssueStatus } from '../../lib/types'
import { STATUS_LABELS } from '../../ui/StatusBadge'

const STATUSES = Object.keys(STATUS_LABELS) as IssueStatus[]

/** A native select: keyboard accessible for free, and visually as plain as
 *  the rest of the interface. */
export function StatusSelect({
  value,
  onChange,
  disabled,
}: {
  value: IssueStatus
  onChange: (status: IssueStatus) => void
  disabled?: boolean
}) {
  return (
    <label>
      <span className="sr-only">Status</span>
      <select
        className="border border-grey-300 bg-paper px-1 py-0.5 text-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as IssueStatus)}
      >
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </select>
    </label>
  )
}
