import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import type { Project, Sprint } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { List } from '../../ui/List'
import { Button } from '../../ui/Button'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { useSession } from '../auth/useSession'
import { SprintForm, type SprintInput } from '../work/CoreForms'
import { projectChoices, projectsQuery, sprintsQuery } from '../work/workLinks'

/** Each project runs its own sprints, so the page lists them per project. */
function groupByProject(sprints: Sprint[], projects: Project[]) {
  const byId = new Map(projects.map((project) => [project.id, project]))
  const groups = new Map<string, { project: Project | undefined; sprints: Sprint[] }>()
  for (const sprint of sprints) {
    const group = groups.get(sprint.project_id) ?? { project: byId.get(sprint.project_id), sprints: [] }
    group.sprints.push(sprint)
    groups.set(sprint.project_id, group)
  }
  return [...groups.entries()].sort(([, a], [, b]) =>
    (a.project?.name ?? '').localeCompare(b.project?.name ?? ''))
}

export function SprintList({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const isAdmin = workspace?.role === 'admin'
  const [creatingSprint, setCreatingSprint] = useState(false)
  const query = useQuery(sprintsQuery(slug))
  const projects = useQuery(projectsQuery(slug))
  const create = useMutation({
    mutationFn: (input: SprintInput) => api.post<Sprint>(`/w/${slug}/sprints`, input),
    onSuccess: () => {
      setCreatingSprint(false)
      return queryClient.invalidateQueries({ queryKey: ['sprints', slug] })
    },
  })

  if (query.isPending || projects.isPending) return <LoadingState />
  if (query.error || projects.error) {
    return (
      <ErrorState
        message="Could not load sprints."
        onRetry={() => {
          void query.refetch()
          void projects.refetch()
        }}
        retrying={query.isRefetching || projects.isRefetching}
      />
    )
  }

  const sprints = query.data.sprints
  const allProjects = projects.data.projects
  const choices = projectChoices(allProjects)
  const groups = groupByProject(sprints, allProjects)

  return (
    <div className="w-full min-w-0">
      <PageHeader
        title="Sprints"
        description="Each project runs its own sprints, one active at a time."
        actions={isAdmin && !creatingSprint && choices.length > 0 ? (
          <Button variant="primary" onClick={() => setCreatingSprint(true)}>New sprint</Button>
        ) : undefined}
      />
      {isAdmin && creatingSprint ? (
        <section className="ui-surface mb-6 p-4" aria-labelledby="new-sprint-heading">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="new-sprint-heading" className="font-medium">New sprint</h2>
              <p className="mt-1 text-sm text-grey-500">Set the next time window for one project.</p>
            </div>
            <Button onClick={() => setCreatingSprint(false)}>Cancel</Button>
          </div>
          <SprintForm projects={choices} onSubmit={(input) => create.mutateAsync(input)} />
        </section>
      ) : null}
      {sprints.length === 0 ? (
        choices.length === 0 ? (
          <EmptyState
            title="No projects yet"
            message="A sprint belongs to a project. Create a project first, then plan its first sprint."
            action={<NavLink to={`/w/${slug}/projects`} className="text-sm underline">Go to projects</NavLink>}
          />
        ) : (
          <EmptyState
            title="No sprints yet"
            message={isAdmin ? 'Create the first sprint for a project.' : 'An admin creates the first sprint for a project.'}
          />
        )
      ) : (
        <div className="space-y-6">
          {groups.map(([projectId, group]) => {
            const headingId = `sprints-project-${projectId}`
            return (
              <section key={projectId} aria-labelledby={headingId} data-testid={`sprint-project-${group.project?.key ?? projectId}`}>
                <SectionHeader
                  id={headingId}
                  title={group.project?.name ?? 'Project'}
                  meta={group.project?.key}
                />
                <List
                  items={group.sprints}
                  ariaLabel={`${group.project?.name ?? 'Project'} sprints`}
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
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
