import type { Issue } from '../../lib/types'
import { List } from '../../ui/List'
import { EmptyState } from '../../ui/EmptyState'
import { StatusBadge } from '../../ui/StatusBadge'

/** The keyboard-navigable issue list every view reuses. */
export function IssueList({
  issues,
  onOpen,
  ariaLabel = 'Issues',
}: {
  issues: Issue[]
  onOpen?: (issue: Issue) => void
  ariaLabel?: string
}) {
  if (issues.length === 0) return <EmptyState title="No issues here" />

  return (
    <List
      items={issues}
      ariaLabel={ariaLabel}
      keyExtractor={(issue) => issue.id}
      onActivate={(issue) => onOpen?.(issue)}
      renderItem={(issue) => (
        <span className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1 text-sm">
          <span className="w-20 shrink-0 text-grey-500">{issue.key}</span>
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{issue.title}</span>
          <span className="col-start-2">
            <StatusBadge status={issue.status} />
          </span>
        </span>
      )}
    />
  )
}
