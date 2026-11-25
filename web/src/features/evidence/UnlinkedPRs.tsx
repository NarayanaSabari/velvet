import { ErrorNote } from '../../ui/ErrorNote'
import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Issue, PullRequest, SuggestedNote } from '../../lib/types'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { RelativeTime } from '../../ui/RelativeTime'
import { useSession } from '../auth/useSession'
import { pullRequestStateLabel } from './pullRequestState'
import { SuggestionLine } from './SuggestionLine'
import { TextField } from '../../ui/fields'

/**
 * Pull requests the linker could not match to an issue, plus project notes
 * Jev thinks belong on one.
 *
 * Unmatched work stays visible rather than disappearing: silently dropping a
 * PR is how a team stops trusting the record. A suggestion makes filing it one
 * click, and the key field stays for when the suggestion is wrong or absent.
 */
export function UnlinkedPRs({ slug }: { slug: string }) {
  const session = useSession(slug)
  // Viewers can read but not link; the server enforces this either way.
  const canWrite = session.workspace?.role !== 'viewer'
  const query = useQuery({
    queryKey: ['unlinked', slug],
    queryFn: () => api.get<{ pull_requests: PullRequest[] }>(`/w/${slug}/pull-requests/unlinked`),
  })
  const notes = useQuery({
    queryKey: ['suggested-notes', slug],
    queryFn: () => api.get<{ notes: SuggestedNote[] }>(`/w/${slug}/suggestions/notes`),
  })

  const header = (
    <PageHeader
      title="Unlinked PRs"
      description={<>Pull requests with no matching issue. Name the branch after an issue key, such as <span className="font-mono text-grey-700">sabari/eng-42-fix-auth</span>, and they link themselves. Jev suggests an issue when one clearly fits; nothing is linked until you choose.</>}
    />
  )

  if (query.isPending || query.error) {
    return (
      <div className="w-full min-w-0">
        {header}
        {query.isPending ? <LoadingState /> : (
          <ErrorState
            message="Could not load pull requests."
            onRetry={() => void query.refetch()}
            retrying={query.isRefetching}
          />
        )}
      </div>
    )
  }

  const prs = query.data.pull_requests ?? []
  const suggested = prs.filter((pr) => pr.suggestion).length

  return (
    <div className="w-full min-w-0">
      {header}

      {prs.length === 0 ? (
        <EmptyState
          title="Nothing unlinked"
          message="Every pull request is attached to an issue."
        />
      ) : (
        <>
          {suggested > 0 ? (
            <Text as="p" type="supporting" color="secondary" display="block" className="mb-2">{suggested} of {prs.length} have a suggested issue.</Text>
          ) : null}
          <div className="border-y border-grey-200">
            <List hasDividers density="balanced" edge="flush" aria-label="Unlinked pull requests">
              {prs.map((pr) => (
                <UnlinkedRow key={pr.id} pr={pr} slug={slug} canWrite={canWrite} />
              ))}
            </List>
          </div>
        </>
      )}

      <SuggestedNotes slug={slug} query={notes} canWrite={canWrite} />
    </div>
  )
}

/**
 * Project notes with a suggested issue. A note without one is not listed:
 * logging against a project is a normal home for work, not a gap to close.
 */
function SuggestedNotes({
  slug,
  query,
  canWrite,
}: {
  slug: string
  query: ReturnType<typeof useQuery<{ notes: SuggestedNote[] }>>
  canWrite: boolean
}) {
  if (query.isPending) return null
  if (query.error) {
    return (
      <section aria-labelledby="suggested-notes" className="mt-8">
        <SectionHeader id="suggested-notes" title="Notes that may belong on an issue" />
        <ErrorState
          message="Could not load suggested notes."
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
      </section>
    )
  }
  const notes = query.data.notes ?? []
  if (notes.length === 0) return null

  return (
    <section aria-labelledby="suggested-notes" className="mt-8">
      <SectionHeader id="suggested-notes" title="Notes that may belong on an issue" meta={notes.length} />
      <Text as="p" type="supporting" color="secondary" display="block" className="mb-2">
        Logged against a project. Filing one moves it, with its replies, onto the issue's log.
      </Text>
      <div className="border-b border-grey-200">
      <List hasDividers density="balanced" edge="flush" aria-label="Notes that may belong on an issue">
        {notes.map((note) => (
          <ListItem key={note.comment.id} itemKey={note.comment.id} label={(
          <div className="min-w-0 py-1 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-grey-500">
              <span className="font-mono">{note.project_key}</span>
              <span>{note.comment.author.name || note.comment.author.github_login}</span>
              {note.comment.source === 'agent' ? <span>Agent</span> : null}
              <RelativeTime iso={note.comment.created_at} />
            </div>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap [overflow-wrap:anywhere]">{note.comment.body}</p>
            <SuggestionLine
              slug={slug}
              suggestion={note.suggestion}
              acceptLabel="File under"
              canWrite={canWrite}
              invalidate={[['suggested-notes', slug]]}
            />
          </div>
          )} />
        ))}
      </List>
      </div>
    </section>
  )
}

function UnlinkedRow({ pr, slug, canWrite }: { pr: PullRequest; slug: string; canWrite: boolean }) {
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
    <ListItem itemKey={pr.id} label={(
    <div className="min-w-0 py-1 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <a className="inline-flex min-h-11 items-center text-grey-500 underline sm:min-h-0" href={pr.html_url} target="_blank" rel="noreferrer">
          #{pr.number}
        </a>
        <span className="min-w-[12rem] flex-1 break-words font-medium [overflow-wrap:anywhere]">{pr.title}</span>
        <span className={merged ? 'text-done' : 'text-grey-500'}>
          {pullRequestStateLabel(pr)}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-grey-500">
        <span>{pr.author_login}</span>
        <span className="text-grey-700">+{pr.additions}</span>
        <span className="text-grey-700">-{pr.deletions}</span>
        {pr.head_ref ? <span className="truncate">{pr.head_ref}</span> : null}
        {pr.gh_updated_at ? <RelativeTime iso={pr.gh_updated_at} /> : null}
      </div>

      {pr.suggestion ? (
        <SuggestionLine
          slug={slug}
          suggestion={pr.suggestion}
          acceptLabel="Link to"
          canWrite={canWrite}
          invalidate={[['unlinked', slug]]}
        />
      ) : null}

      {canWrite ? (
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (key.trim()) attach.mutate(key)
        }}
      >
        <TextField
          className="w-32"
          label={`Issue key for pull request ${pr.number}`}
          hideLabel
          placeholder="ENG-42"
          value={key}
          onChange={(value) => {
            setKey(value)
            setError(null)
          }}
        />
        <Button type="submit" disabled={!key.trim() || attach.isPending}>
          {attach.isPending ? 'Attaching…' : 'Attach'}
        </Button>
        {error ? <ErrorNote className="basis-full">{error}</ErrorNote> : null}
      </form>
      ) : null}
    </div>
    )} />
  )
}
