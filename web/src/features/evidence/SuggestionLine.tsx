import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { api, ApiError } from '../../lib/api'
import type { LinkSuggestion } from '../../lib/types'
import { Button } from '../../ui/Button'

/**
 * One Jev suggestion: the issue it thinks this work belongs to, with Link and
 * Dismiss. It is labelled as a suggestion in words, and accepting it only
 * files the work; it never changes the issue's status.
 */
export function SuggestionLine({
  slug,
  suggestion,
  acceptLabel,
  canWrite,
  invalidate,
}: {
  slug: string
  suggestion: LinkSuggestion
  /** The verb for this kind of work, such as "Link to" or "File under". */
  acceptLabel: string
  canWrite: boolean
  invalidate: readonly (readonly unknown[])[]
}) {
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const refresh = () => {
    for (const queryKey of invalidate) void client.invalidateQueries({ queryKey })
    void client.invalidateQueries({ queryKey: ['activity', slug] })
  }
  const onError = (err: Error) => {
    // A suggestion handled elsewhere is not a failure worth retrying.
    if (err instanceof ApiError && err.status === 409) {
      refresh()
      return
    }
    setError(err.message)
  }
  const accept = useMutation({
    mutationFn: () => api.post(`/w/${slug}/suggestions/${suggestion.id}/accept`),
    onSuccess: refresh,
    onError,
  })
  const dismiss = useMutation({
    mutationFn: () => api.post(`/w/${slug}/suggestions/${suggestion.id}/dismiss`),
    onSuccess: refresh,
    onError,
  })
  const pending = accept.isPending || dismiss.isPending
  const key = suggestion.issue_key

  return (
    <div className="mt-3 border-l-2 border-grey-300 pl-3" aria-busy={pending}>
      <p className="text-sm text-grey-700">
        <span className="text-grey-500">Suggested issue: </span>
        <NavLink to={`/w/${slug}/issues/${key}`} className="font-mono text-ink underline">
          {key}
        </NavLink>{' '}
        <span className="[overflow-wrap:anywhere]">{suggestion.issue_title}</span>
      </p>
      {canWrite ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            className="min-h-9"
            variant="primary"
            disabled={pending}
            onClick={() => { setError(null); accept.mutate() }}
          >
            {accept.isPending ? 'Linking…' : `${acceptLabel} ${key}`}
          </Button>
          <Button
            className="min-h-9"
            variant="ghost"
            disabled={pending}
            aria-label={`Dismiss suggestion ${key}`}
            onClick={() => { setError(null); dismiss.mutate() }}
          >
            {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-sm text-blocked">{error}</p> : null}
    </div>
  )
}
