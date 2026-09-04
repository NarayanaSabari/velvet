import type { IssueStatus, PullRequest } from '../../lib/types'
import { Button } from '../../ui/Button'
import { RelativeTime } from '../../ui/RelativeTime'

/** A merged PR is proof of work, not a decision that the work is finished, so
 *  the prompt is pointless once the issue has already been resolved. */
const RESOLVED: IssueStatus[] = ['done', 'cancelled']

export function EvidenceCard({
  pr,
  issueStatus,
  onMarkDone,
}: {
  pr: PullRequest
  issueStatus: IssueStatus
  onMarkDone: () => void
}) {
  const merged = pr.state === 'merged' || Boolean(pr.merged_at)
  const prompt = merged && !RESOLVED.includes(issueStatus)

  return (
    <div className="border border-grey-200 px-2 py-1.5 text-sm">
      <div className="flex items-baseline gap-2">
        <a className="text-grey-500 underline" href={pr.html_url} target="_blank" rel="noreferrer">
          #{pr.number}
        </a>
        <span className="min-w-0 flex-1 truncate">{pr.title}</span>
        {/* Green means merged, and the word says so too: colour is never the
            only signal. */}
        <span className={merged ? 'text-done' : 'text-grey-500'}>
          {pr.draft ? 'Draft' : merged ? 'Merged' : pr.state}
        </span>
      </div>

      <div className="mt-0.5 flex items-center gap-2 text-grey-500">
        <span>{pr.author_login}</span>
        {/* Diff size is information, not judgement: a deletion is not a
            problem, and red is reserved for blocked or destructive. */}
        <span className="text-grey-700">+{pr.additions}</span>
        <span className="text-grey-700">-{pr.deletions}</span>
        {pr.merged_at ? <RelativeTime iso={pr.merged_at} /> : null}
      </div>

      {prompt ? (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-grey-700">PR merged - is this issue done?</span>
          {/* The card only ever asks. Marking done runs the ordinary status
              mutation, in the person's own hands. */}
          <Button onClick={onMarkDone}>Mark issue done</Button>
        </div>
      ) : null}
    </div>
  )
}
