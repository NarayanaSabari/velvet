import { ErrorNote } from '../../ui/ErrorNote'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { SuggestionSettings } from '../../lib/types'
import { SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { CheckboxField } from '../../ui/fields'

/**
 * The organisation's switch for Jev link suggestions. It says plainly what is
 * sent to TypeSafe and whether the server can make suggestions at all, so
 * "on" never implies something is running when no key is configured.
 */
export function SuggestionsPanel({ slug }: { slug: string }) {
  const client = useQueryClient()
  const queryKey = ['suggestion-settings', slug]
  const settings = useQuery({
    queryKey,
    queryFn: () => api.get<SuggestionSettings>(`/w/${slug}/suggestions/settings`),
  })
  // The choice shows at once and stays while it saves; a failed save puts the
  // saved value back.
  const [pending, setPending] = useState<boolean | null>(null)
  const update = useMutation({
    mutationFn: (enabled: boolean) => api.patch<SuggestionSettings>(`/w/${slug}/suggestions/settings`, { enabled }),
    onSuccess: (next) => {
      client.setQueryData(queryKey, next)
      void client.invalidateQueries({ queryKey: ['unlinked', slug] })
      void client.invalidateQueries({ queryKey: ['suggested-notes', slug] })
    },
    onSettled: () => setPending(null),
  })

  return (
    <section aria-labelledby="jev-suggestions" className="mt-10 max-w-2xl">
      <SectionHeader id="jev-suggestions" title="Suggested issue links" />
      {settings.isPending ? (
        <LoadingState className="">Loading…</LoadingState>
      ) : settings.error ? (
        <ErrorState
          message="Could not load the suggestion setting."
          onRetry={() => void settings.refetch()}
          retrying={settings.isRefetching}
        />
      ) : (
        <>
          <CheckboxField
            label="Suggest which issue unlinked pull requests and project notes belong to"
            checked={pending ?? settings.data.enabled}
            disabled={update.isPending}
            onChange={(checked) => {
              setPending(checked)
              update.mutate(checked)
            }}
          />
          <p className="mt-1 text-sm text-grey-500">
            Jev, a model from TypeSafe, reads each unlinked pull request (title, description, branch, commit messages)
            or project note, together with this organisation's open issues, and suggests one when it clearly fits.
            That text is sent to TypeSafe. Nothing is linked until someone chooses, and no issue status ever changes.
          </p>
          {!settings.data.available ? (
            <p className="mt-2 text-xs text-stale">
              Not running: this server has no TypeSafe API key, so no suggestions are made yet.
            </p>
          ) : null}
          <div aria-live="polite">
            {update.isPending ? <LoadingState className="mt-2">Saving…</LoadingState> : null}
          </div>
          {update.error ? <ErrorNote className="mt-2">{update.error.message}</ErrorNote> : null}
        </>
      )}
    </section>
  )
}
