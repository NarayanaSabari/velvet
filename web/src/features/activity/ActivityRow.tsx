import type { ReactNode } from 'react'

import type { Activity, IssueStatus } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { STATUS_LABELS } from '../../ui/StatusBadge'
import { Avatar } from '../../ui/Avatar'
import { RelativeTime } from '../../ui/RelativeTime'
import { NavLink } from '../../app/nav'

/** Underlined as well as inked, so a link is not told apart by colour alone. */
const LINK_CLASS = 'text-ink underline decoration-grey-500 underline-offset-2 hover:decoration-ink'

/** Names a thing in the row, as a link when the row knows where it lives. */
function Named({ to, children }: { to: string | null; children: ReactNode }) {
  if (!to) return <span className="text-ink">{children}</span>
  return <NavLink to={to} className={LINK_CLASS}>{children}</NavLink>
}

/**
 * The milestone a row is about. A comment's activity targets the comment
 * itself, so the milestone it was written on travels in the metadata.
 */
function milestoneId(activity: Activity): string | null {
  if (activity.target_type === 'milestone') return activity.target_id
  if (str(activity.metadata, 'target_type') === 'milestone') return str(activity.metadata, 'target_id')
  return null
}

function str(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' ? value : null
}

function num(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key]
  return typeof value === 'number' ? value : null
}

function memberLabel(metadata: Record<string, unknown>): string {
  const email = str(metadata, 'email')
  const login = str(metadata, 'github_login')
  return email ? userLabel({ email }) : login ? `@${login}` : 'someone'
}

/** Status metadata comes from the API as free text, so it is labelled only
 *  when it names a status this build knows about. */
function statusLabel(raw: string | null): string | null {
  if (!raw) return null
  return STATUS_LABELS[raw as IssueStatus] ?? raw
}

/**
 * A pull request lives on GitHub, so its number opens there in a new tab.
 * The address comes from activity metadata, which is free-form, so anything
 * that is not a web address stays plain text.
 */
function PullRequestNumber({ metadata }: { metadata: Record<string, unknown> }) {
  const label = `#${num(metadata, 'number')}`
  const url = str(metadata, 'html_url')
  if (!url || !/^https?:\/\//i.test(url)) return <span className="text-ink">{label}</span>
  return (
    <a className={LINK_CLASS} href={url} target="_blank" rel="noreferrer">
      {label}
    </a>
  )
}

function IssueKey({ metadata, slug }: { metadata: Record<string, unknown>; slug?: string }) {
  const key = str(metadata, 'key')
  return key ? <Named to={slug ? `/w/${slug}/issues/${key}` : null}>{key}</Named> : null
}

/**
 * Names what an activity happened to. A comment on a milestone carries no
 * issue key, so without this the row rendered a dangling "commented on" with
 * nothing after it.
 */
function Target({ activity, slug }: { activity: Activity; slug?: string }) {
  const { metadata } = activity
  // A project comment also carries a key, but it is the project's, not an issue's.
  const onProject = str(metadata, 'target_type') === 'project'
  const key = str(metadata, 'key')
  if (key && !onProject) return <IssueKey metadata={metadata} slug={slug} />

  const milestone = milestoneId(activity)
  const name = (onProject ? key : null) ?? str(metadata, 'name') ?? str(metadata, 'title')
  if (name) {
    return <Named to={slug && milestone ? `/w/${slug}/milestones/${milestone}` : null}>{name}</Named>
  }

  return <span className="text-ink">{activity.target_type === 'milestone' ? 'a milestone' : 'an issue'}</span>
}

/**
 * One row of the work log. The verb switch has a default branch on purpose:
 * the API may add verbs before the SPA knows them, and a vague row is a far
 * better failure than a feed that crashes.
 */
export function ActivityRow({ activity, slug, hideActor = false }: {
  activity: Activity
  /** The organisation the row belongs to. With it, issues, milestones and
   *  sprints named in the row link to their pages. */
  slug?: string
  /** For a list that is all one person's work, such as the dashboard's own
   *  activity: the row starts with the action instead of repeating a name. */
  hideActor?: boolean
}) {
  const { actor, metadata, verb } = activity
  const who = userLabel(actor)

  let body: ReactNode
  switch (verb) {
    case 'commented': {
      const excerpt = str(metadata, 'excerpt')
      body = (
        <>
          <span>
            commented on <Target activity={activity} slug={slug} />
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
          created <IssueKey metadata={metadata} slug={slug} /> {str(metadata, 'title')}
        </span>
      )
      break
    case 'changed_status':
      body = (
        <span>
          moved <IssueKey metadata={metadata} slug={slug} /> from{' '}
          <span className="text-ink">{statusLabel(str(metadata, 'from'))}</span> to{' '}
          <span className="text-ink">{statusLabel(str(metadata, 'to'))}</span>
        </span>
      )
      break
    case 'assigned':
      body = (
        <span>
          assigned <IssueKey metadata={metadata} slug={slug} /> to{' '}
          {str(metadata, 'assignee_login') ?? 'someone'}
        </span>
      )
      break
    case 'attached_pr':
      body = (
        <span>
          attached PR <PullRequestNumber metadata={metadata} /> to{' '}
          <Target activity={activity} slug={slug} />
        </span>
      )
      break
    case 'filed_entry':
      body = (
        <span>
          filed a {str(metadata, 'project_key') ?? 'project'} note under <IssueKey metadata={metadata} slug={slug} />
        </span>
      )
      break
    case 'completed_milestone':
      body = (
        <span>
          completed milestone{' '}
          <Named to={slug ? `/w/${slug}/milestones/${activity.target_id}` : null}>{str(metadata, 'name')}</Named>
        </span>
      )
      break
    case 'closed_sprint':
      body = (
        <span>
          closed sprint{' '}
          <Named to={slug ? `/w/${slug}/sprints/${activity.target_id}` : null}>{str(metadata, 'name')}</Named>
        </span>
      )
      break
    case 'invited_member':
      body = (
        <span>
          {`invited ${memberLabel(metadata)} as ${str(metadata, 'role') ?? 'member'}`}
        </span>
      )
      break
    case 'changed_member_role':
      body = (
        <span>
          {`changed ${memberLabel(metadata)} from ${str(metadata, 'from') ?? 'unknown'} to ${str(metadata, 'to') ?? 'unknown'}`}
        </span>
      )
      break
    default:
      // Unknown verb: say what happened in the most generic honest terms.
      body = (
        <span>
          {verb.replace(/_/g, ' ')} <IssueKey metadata={metadata} slug={slug} />
        </span>
      )
  }

  return (
    <div className="flex gap-2 text-sm">
      {hideActor ? null : <Avatar user={actor} />}
      {hideActor ? (
        <div className="min-w-0 flex-1 text-grey-700 [overflow-wrap:anywhere] first-letter:uppercase">
          {body}
        </div>
      ) : (
        <div className="min-w-0 flex-1 text-grey-700 [overflow-wrap:anywhere]">
          <span className="text-ink">{who}</span> {body}
        </div>
      )}
      <RelativeTime iso={activity.created_at} />
    </div>
  )
}
