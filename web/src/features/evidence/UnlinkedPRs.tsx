import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Issue, PullRequest } from '../../lib/types'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { RelativeTime } from '../../ui/RelativeTime'

/**
 * Pull requests the linker could not match to an issue.
 *
 * Unmatched work stays visible rather than disappearing: silently dropping a
 * PR is how a team stops trusting the record. One field and one click is all
 * it takes to file it against the right issue.
 */
export function UnlinkedPRs({ slug }: { slug: string }) {
  const query = useQuery({
    queryKey: ['unlinked', slug],
    queryFn: () => api.get<{ pull_requests: PullRequest[] }>(`/w/${slug}/pull-requests/unlinked`),
  })

  if (query.isPending) return <p className="text-grey-500">Loading…</p>
  if (query.error) return <p className="text-blocked">Could not load pull requests.</p>

  const prs = query.data.pull_requests ?? []

  return (
    <div className="max-w-[80rem]">
      <h1 className="mb-1 text-lg">Unlinked PRs</h1>
      <p className="mb-4 text-grey-500">
        Pull requests with no matching issue. Name the branch after an issue key, such as{' '}
        <span className="text-grey-700">sabari/eng-42-fix-auth</span>, and they link themselves.
      </p>

      {prs.length === 0 ? (
        <EmptyState
          title="Nothing unlinked"
          message="Every pull request is attached to an issue."
        />
      ) : (
        <ul className="border-t border-grey-200">
          {prs.map((pr) => (
            <UnlinkedRow key={pr.id} pr={pr} slug={slug} />
          ))}
        </ul>
      )}
    </div>
  )
}

function UnlinkedRow({ pr, slug }: { pr: PullRequest; slug: string }) {
  const queryClient = useQueryClient()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const attach = useMutation({
    mutationFn: async (issueKey: string) => {
      // Resolve the key first so a typo is reported as "no such issue" rather
      // than as a failed attach.
      const issue = await api.get<Issue>(`/w/${slug}/issues/${issueKey.trim().toUpperCase()}`)
      await api.post(`/w/${slug}/issues/${issue.key}/prs`, { pull_request_id: pr.id })
    },
    onSuccess: () => {
      setKey('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['unlinked', slug] })
      void queryClient.invalidateQueries({ queryKey: ['activity', slug] })
    },
    onError: () => setError('No issue with that key.'),
  })

  const merged = pr.state === 'merged' || Boolean(pr.merged_at)

  return (
    <li className="border-b border-grey-200 px-2 py-1.5 text-sm">
      <div className="flex items-baseline gap-2">
        <a className="text-grey-500 underline" href={pr.html_url} target="_blank" rel="noreferrer">
          #{pr.number}
        </a>
        <span className="min-w-0 flex-1 truncate">{pr.title}</span>
        <span className={merged ? 'text-done' : 'text-grey-500'}>
          {merged ? 'Merged' : pr.state}
        </span>
      </div>

      <div className="mt-0.5 flex items-center gap-2 text-grey-500">
        <span>{pr.author_login}</span>
        <span className="text-grey-700">+{pr.additions}</span>
        <span className="text-grey-700">-{pr.deletions}</span>
        {pr.head_ref ? <span className="truncate">{pr.head_ref}</span> : null}
        {pr.gh_updated_at ? <RelativeTime iso={pr.gh_updated_at} /> : null}
      </div>

      <form
        className="mt-1.5 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (key.trim()) attach.mutate(key)
        }}
      >
        <label className="sr-only" htmlFor={`attach-${pr.id}`}>
          Issue key for pull request {pr.number}
        </label>
        <input
          id={`attach-${pr.id}`}
          className="w-32 border border-grey-300 bg-paper px-1.5 py-0.5 text-sm"
          placeholder="ENG-42"
          value={key}
          onChange={(event) => {
            setKey(event.target.value)
            setError(null)
          }}
        />
        <Button type="submit" disabled={!key.trim() || attach.isPending}>
          {attach.isPending ? 'Attaching…' : 'Attach'}
        </Button>
        {error ? <span className="text-blocked">{error}</span> : null}
      </form>
    </li>
  )
}
