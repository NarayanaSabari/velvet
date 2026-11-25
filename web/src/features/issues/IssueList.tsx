import { List, ListItem } from '@astryxdesign/core/List'

import type { Issue } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { StatusBadge } from '../../ui/StatusBadge'

/**
 * A compact list of issues for a narrow column, such as a milestone's side
 * panel. Each row is one link to its issue: the key, the full title, and the
 * status beneath.
 */
export function IssueList({
  issues,
  slug,
  ariaLabel = 'Issues',
}: {
  issues: Issue[]
  slug: string
  ariaLabel?: string
}) {
  if (issues.length === 0) return <EmptyState title="No issues here" />

  return (
    <div className="border-y border-grey-200">
      <List hasDividers density="balanced" edge="flush" aria-label={ariaLabel}>
        {issues.map((issue) => (
          <ListItem
            key={issue.id}
            itemKey={issue.id}
            href={`/w/${slug}/issues/${issue.key}`}
            label={(
              <span className="block min-w-0">
                <span className="block font-mono text-xs text-grey-500">{issue.key}</span>
                {/* The whole title stays readable; it wraps, never truncates. */}
                <span className="block min-w-0 text-sm font-medium break-words text-ink [overflow-wrap:anywhere]">{issue.title}</span>
                {/* Under the title, not beside it: the column is narrow and
                    the title needs its whole width. */}
                <span className="mt-1 block"><StatusBadge status={issue.status} /></span>
              </span>
            )}
          />
        ))}
      </List>
    </div>
  )
}
