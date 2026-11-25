import { FormDialog } from '../../ui/FormDialog'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Heading } from '../../ui/Heading'
import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import { formatDay, stateLabel } from '../../lib/formatDate'
import type { Project, Sprint } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { Button } from '../../ui/Button'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { useSession } from '../auth/useSession'
import { SprintForm, type SprintInput } from '../work/CoreForms'
import { projectChoices, projectsQuery, sprintsQuery } from '../work/workLinks'
import { RunningSprints } from './RunningSprints'
import { SprintStrip, StripKey } from './SprintStrip'

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

/** The calendar needs room for a row of readable bars. Without matchMedia
 *  (tests) the wide layout is assumed. */
function useWideEnoughForCalendar(): boolean {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setWide(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return wide
}

export function SprintList({ slug }: { slug: string }) {
  const wide = useWideEnoughForCalendar()
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

  const plainHeader = <PageHeader title="Sprints" description="Each project runs its own sprints, one active at a time." />
  if (query.isPending || projects.isPending) {
    return <div className="w-full min-w-0">{plainHeader}<LoadingState /></div>
  }
  if (query.error || projects.error) {
    return (
      <div className="w-full min-w-0">
      {plainHeader}
      <ErrorState
        message="Could not load sprints."
        onRetry={() => {
          void query.refetch()
          void projects.refetch()
        }}
        retrying={query.isRefetching || projects.isRefetching}
      />
      </div>
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
        actions={isAdmin && choices.length > 0 ? (
          <Button variant="primary" onClick={() => setCreatingSprint(true)}>New sprint</Button>
        ) : undefined}
      />
      {isAdmin && creatingSprint ? (
        <FormDialog title="New sprint" description="Set the next time window for one project." onClose={() => setCreatingSprint(false)}>
          <SprintForm projects={choices} onSubmit={(input) => create.mutateAsync(input)} />
        </FormDialog>
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
      ) : wide ? (
        // Every project's sprints on one calendar, so overlaps and gaps
        // between projects read straight across.
        <div className="space-y-8">
          <div className="space-y-4">
          <StripKey />
          <SprintStrip
            slug={slug}
            rows={groups.map(([projectId, group]) => ({
              id: projectId,
              name: group.project?.name ?? 'Project',
              testId: `sprint-project-${group.project?.key ?? projectId}`,
              // Oldest first, so time runs left to right along the row.
              sprints: [...group.sprints].sort((a, b) => a.starts_on.localeCompare(b.starts_on)),
            }))}
            lead={(row) => {
              const project = allProjects.find((candidate) => candidate.id === row.id)
              return (
                <>
                  <Heading level={4} accessibilityLevel={2} className="truncate">{row.name}</Heading>
                  <Text type="supporting" color="secondary">
                    {project ? <Text type="code" color="secondary">{project.key}</Text> : null}
                    {project ? ' · ' : ''}{row.sprints.length} {row.sprints.length === 1 ? 'sprint' : 'sprints'}
                  </Text>
                </>
              )
            }}
          />
          </div>
          <RunningSprints
            slug={slug}
            groups={groups.map(([projectId, group]) => ({ id: projectId, project: group.project, sprints: group.sprints }))}
          />
        </div>
      ) : (
        // A calendar needs width. Narrow screens keep the list.
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
                {/* The section heading's rule is the list's top edge. */}
                <div className="border-b border-grey-200">
                  <List hasDividers density="balanced" edge="flush" aria-label={`${group.project?.name ?? 'Project'} sprints`}>
                    {group.sprints.map((sprint) => (
                      <ListItem
                        key={sprint.id}
                        itemKey={sprint.id}
                        href={`/w/${slug}/sprints/${sprint.id}`}
                        label={(
                          <span className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:items-baseline sm:gap-4">
                            <span className="min-w-0 flex-1 font-medium break-words text-ink [overflow-wrap:anywhere]">{sprint.name}</span>
                            <span className="flex flex-wrap gap-x-4 text-xs text-grey-500 sm:shrink-0 sm:text-sm">
                              <span><time dateTime={sprint.starts_on}>{formatDay(sprint.starts_on)}</time> – <time dateTime={sprint.ends_on}>{formatDay(sprint.ends_on)}</time></span>
                              {/* A fixed column on wide screens, so states line up down the list. */}
                              <span className={`sm:w-24 sm:text-right ${sprint.state === 'active' ? 'font-medium text-ink' : ''}`}>{stateLabel(sprint.state)}</span>
                            </span>
                          </span>
                        )}
                      />
                    ))}
                  </List>
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
