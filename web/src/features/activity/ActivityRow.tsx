import type { ReactNode } from 'react'

import type { Activity, IssueStatus } from '../../lib/types'
import { STATUS_LABELS } from '../../ui/StatusBadge'
import { Avatar } from '../../ui/Avatar'
import { RelativeTime } from '../../ui/RelativeTime'

function str(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' ? value : null
}

function num(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key]
  return typeof value === 'number' ? value : null
}

/** Status metadata comes from the API as free text, so it is labelled only
 *  when it names a status this build knows about. */
function statusLabel(raw: string | null): string | null {
  if (!raw) return null
  return STATUS_LABELS[raw as IssueStatus] ?? raw
}

function IssueKey({ metadata }: { metadata: Record<string, unknown> }) {
  const key = str(metadata, 'key')
  return key ? <span className="text-ink">{key}</span> : null
}

/**
 * Names what an activity happened to. A comment on a milestone carries no
 * issue key, so without this the row rendered a dangling "commented on" with
 * nothing after it.
 */
function Target({
  metadata,
  targetType,
}: {
  metadata: Record<string, unknown>
  targetType: string
}) {
  const key = str(metadata, 'key')
  if (key) return <span className="text-ink">{key}</span>

  const name = str(metadata, 'name') ?? str(metadata, 'title')
  if (name) return <span className="text-ink">{name}</span>

  return <span className="text-ink">{targetType === 'milestone' ? 'a milestone' : 'an issue'}</span>
}

/**
 * One row of the work log. The verb switch has a default branch on purpose:
 * the API may add verbs before the SPA knows them, and a vague row is a far
 * better failure than a feed that crashes.
 */
export function ActivityRow({ activity }: { activity: Activity }) {
  const { actor, metadata, verb } = activity
  const who = actor?.name || actor?.github_login || 'Someone'

  let body: ReactNode
  switch (verb) {
    case 'commented': {
      const excerpt = str(metadata, 'excerpt')
      body = (
        <>
          <span>
            commented on <Target metadata={metadata} targetType={activity.target_type} />
          </span>
          {excerpt ? (
            <span className="mt-0.5 block border-l border-grey-300 pl-2 text-grey-700">
              {excerpt}
            </span>
          ) : null}
        </>
      )
      break
    }
    case 'created_issue':
      body = (
        <span>
          created <IssueKey metadata={metadata} /> {str(metadata, 'title')}
        </span>
      )
      break
    case 'changed_status':
      body = (
        <span>
          moved <IssueKey metadata={metadata} /> from{' '}
          <span className="text-ink">{statusLabel(str(metadata, 'from'))}</span> to{' '}
          <span className="text-ink">{statusLabel(str(metadata, 'to'))}</span>
        </span>
      )
      break
    case 'assigned':
      body = (
        <span>
          assigned <IssueKey metadata={metadata} /> to{' '}
          {str(metadata, 'assignee_login') ?? 'someone'}
        </span>
      )
      break
    case 'attached_pr':
      body = (
        <span>
          attached PR <span className="text-ink">#{num(metadata, 'number')}</span> to{' '}
          <Target metadata={metadata} targetType={activity.target_type} />
        </span>
      )
      break
    case 'completed_milestone':
      body = <span>completed milestone {str(metadata, 'name')}</span>
      break
    case 'closed_sprint':
      body = <span>closed sprint {str(metadata, 'name')}</span>
      break
    case 'invited_member':
      body = (
        <span>
          {`invited @${str(metadata, 'github_login') ?? 'unknown'} as ${str(metadata, 'role') ?? 'member'}`}
        </span>
      )
      break
    case 'changed_member_role':
      body = (
        <span>
          {`changed @${str(metadata, 'github_login') ?? 'unknown'} from ${str(metadata, 'from') ?? 'unknown'} to ${str(metadata, 'to') ?? 'unknown'}`}
        </span>
      )
      break
    default:
      // Unknown verb: say what happened in the most generic honest terms.
      body = (
        <span>
          {verb.replace(/_/g, ' ')} <IssueKey metadata={metadata} />
        </span>
      )
  }

  return (
    <div className="flex gap-2 text-sm">
      <Avatar user={actor} />
      <div className="min-w-0 flex-1 text-grey-700">
        <span className="text-ink">{who}</span> {body}
      </div>
      <RelativeTime iso={activity.created_at} />
    </div>
  )
}
