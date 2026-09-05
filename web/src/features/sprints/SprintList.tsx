import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { api } from '../../lib/api'
import type { Sprint } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { List } from '../../ui/List'
import { useSession } from '../auth/useSession'
import { SprintForm, type SprintInput } from '../work/CoreForms'

export function SprintList({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const query = useQuery({
    queryKey: ['sprints', slug],
    queryFn: () => api.get<{ sprints: Sprint[] }>(`/w/${slug}/sprints`),
  })
  const create = useMutation({
    mutationFn: (input: SprintInput) => api.post<Sprint>(`/w/${slug}/sprints`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sprints', slug] }),
  })

  if (query.isPending) return <p className="text-grey-500">Loading…</p>
  if (query.error) return <p className="text-blocked">Could not load sprints.</p>

  const sprints = query.data.sprints

  return (
    <div className="max-w-3xl">
      <h1 className="mb-4 text-lg">Sprints</h1>
      {workspace?.role === 'admin' ? (
        <details className="mb-4">
          <summary className="cursor-pointer text-sm underline">New sprint</summary>
          <div className="mt-2"><SprintForm onSubmit={(input) => create.mutateAsync(input)} /></div>
        </details>
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
            <span className="flex items-baseline gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{sprint.name}</span>
              <span className="text-grey-500">
                {sprint.starts_on} – {sprint.ends_on}
              </span>
              <span className="text-grey-500">{sprint.state}</span>
            </span>
          )}
        />
      )}
    </div>
  )
}
