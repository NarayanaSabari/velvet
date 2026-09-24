import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { api } from '../../lib/api'
import type { Sprint } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { List } from '../../ui/List'
import { Button } from '../../ui/Button'
import { PageHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { useSession } from '../auth/useSession'
import { SprintForm, type SprintInput } from '../work/CoreForms'

export function SprintList({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const [creatingSprint, setCreatingSprint] = useState(false)
  const query = useQuery({
    queryKey: ['sprints', slug],
    queryFn: () => api.get<{ sprints: Sprint[] }>(`/w/${slug}/sprints`),
  })
  const create = useMutation({
    mutationFn: (input: SprintInput) => api.post<Sprint>(`/w/${slug}/sprints`, input),
    onSuccess: () => {
      setCreatingSprint(false)
      return queryClient.invalidateQueries({ queryKey: ['sprints', slug] })
    },
  })

  if (query.isPending) return <LoadingState />
  if (query.error) {
    return (
      <ErrorState
        message="Could not load sprints."
        onRetry={() => void query.refetch()}
        retrying={query.isRefetching}
      />
    )
  }

  const sprints = query.data.sprints

  return (
    <div className="max-w-[80rem]">
      <PageHeader
        title="Sprints"
        description="Time-box the work without losing the longer project history."
        actions={workspace?.role === 'admin' && !creatingSprint ? (
          <Button variant="primary" onClick={() => setCreatingSprint(true)}>New sprint</Button>
        ) : undefined}
      />
      {workspace?.role === 'admin' && creatingSprint ? (
        <section className="ui-surface mb-6 p-4" aria-labelledby="new-sprint-heading">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="new-sprint-heading" className="font-medium">New sprint</h2>
              <p className="mt-1 text-sm text-grey-500">Set the next time window for this organisation.</p>
            </div>
            <Button onClick={() => setCreatingSprint(false)}>Cancel</Button>
          </div>
          <SprintForm onSubmit={(input) => create.mutateAsync(input)} />
        </section>
      ) : null}
      {sprints.length === 0 ? (
        <EmptyState title="No sprints yet" message="An admin creates the first month." />
      ) : (
        <List
          items={sprints}
          ariaLabel="Sprints"
          keyExtractor={(sprint) => sprint.id}
          onActivate={(sprint) =>
            void navigate({ href: `/w/${slug}/sprints/${sprint.id}` })
          }
          renderItem={(sprint) => (
            <span className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:items-baseline sm:gap-2">
              <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{sprint.name}</span>
              <span className="flex flex-wrap gap-x-2 text-xs text-grey-500 sm:shrink-0 sm:text-sm">
                <span>{sprint.starts_on} – {sprint.ends_on}</span>
                <span>{sprint.state}</span>
              </span>
            </span>
          )}
        />
      )}
    </div>
  )
}
