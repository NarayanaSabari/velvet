import { Selector, SelectorOption } from '@astryxdesign/core/Selector'

import type { IssueStatus } from '../../lib/types'
import { STATUS_LABELS } from '../../ui/StatusBadge'

const ISSUE_STATUSES = Object.keys(STATUS_LABELS) as IssueStatus[]

const STATUS_OPTIONS = ISSUE_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] }))

const STATUS_DOT_TONES: Record<IssueStatus, string> = {
  backlog: 'bg-grey-300',
  todo: 'bg-grey-500',
  in_progress: 'bg-grey-700',
  in_review: 'bg-stale',
  done: 'bg-done',
  cancelled: 'bg-blocked',
}

export function StatusDot({ status }: { status: IssueStatus }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_TONES[status]}`}
    />
  )
}

/**
 * The control for changing an issue's status: an Astryx Selector drawn as a
 * quiet button, with each status's dot beside its name in the button and in
 * the list. Astryx owns the pop-up, its placement and the keyboard.
 */
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
    <div className="ui-field inline-block" data-testid="issue-status-select">
      <Selector
        {...({
          'data-testid': 'status-listbox',
          'data-current-status': value,
          'data-option-values': JSON.stringify(ISSUE_STATUSES),
        } as Record<string, unknown>)}
        label="Status"
        isLabelHidden
        variant="secondary"
        size="sm"
        value={value}
        options={STATUS_OPTIONS}
        isDisabled={disabled}
        onChange={(next) => {
          if (next && next !== value) onChange(next as IssueStatus)
        }}
        startIcon={<StatusDot status={value} />}
        renderOption={(option) => (
          <SelectorOption
            label={option.label}
            icon={<StatusDot status={option.value as IssueStatus} />}
          />
        )}
      />
    </div>
  )
}
