import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import type { Project } from '../../lib/types'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { useSession } from '../auth/useSession'

/**
 * Projects are the durable unit of work inside an organisation. A milestone is
 * deleted with its sprint, so it cannot name something worked on across
 * several months; a project can.
 */

const controlClass =
  'ui-control min-h-10 w-full px-2 py-1 text-sm md:min-h-8'

const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review'] as const

function openCount(project: Project): number {
  const counts = project.issue_counts ?? {}
  return OPEN_STATUSES.reduce((total, status) => total + (counts[status] ?? 0), 0)
}

function NewProjectForm({
  slug,
  onClose,
}: {
  slug: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const create = useMutation({
    mutationFn: () => api.post<Project>(`/w/${slug}/projects`, { key, name }),
    onSuccess: () => {
      // Clear only on success, so a rejected name is not retyped from scratch.
      setKey('')
      setName('')
      setError('')
      onClose()
      void queryClient.invalidateQueries({ queryKey: ['projects', slug] })
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <form
      className="ui-surface mb-6 max-w-2xl space-y-4 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate()
      }}
    >
      <div>
        <h2 className="text-sm font-medium">New project</h2>
        <p className="mt-1 text-sm text-grey-500">Create a durable home for work that spans several sprints.</p>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-grey-500">Project name</span>
        <input
          className={controlClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-grey-500">Project key</span>
        <input
          className={controlClass}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="velvet"
          required
        />
        <span className="mt-1 block text-xs text-grey-500">
          Lowercase letters, digits, and hyphens. Agents name the project by this key.
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-blocked">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create project'}
        </Button>
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function ProjectsPage({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'
  const [creatingProject, setCreatingProject] = useState(false)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [archivingKey, setArchivingKey] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['projects', slug, includeArchived],
    queryFn: () =>
      api.get<{ projects: Project[] }>(
        `/w/${slug}/projects${includeArchived ? '?include_archived=true' : ''}`,
      ),
  })

  const setStatus = useMutation({
    mutationFn: ({ key, status }: { key: string; status: Project['status'] }) =>
      api.patch<Project>(`/w/${slug}/projects/${key}`, { status }),
    onSuccess: () => {
      setArchivingKey(null)
      void queryClient.invalidateQueries({ queryKey: ['projects', slug] })
    },
  })

  return (
    <div className="w-full min-w-0">
      <PageHeader
        title="Projects"
        description="Keep long-running bodies of work intact while sprints and milestones change around them."
        actions={<>
        {canWrite && !creatingProject ? (
          <Button variant="primary" onClick={() => setCreatingProject(true)}>New project</Button>
        ) : null}
        <label className="flex min-h-8 items-center gap-2 text-sm text-grey-500">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Show archived
        </label>
        </>}
      />

      {creatingProject ? <NewProjectForm slug={slug} onClose={() => setCreatingProject(false)} /> : null}

      {query.isPending ? (
        <LoadingState label="Loading projects…" />
      ) : query.error ? (
        <ErrorState
          message="Could not load projects."
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
      ) : query.data.projects.length === 0 ? (
        <EmptyState
          title={includeArchived ? 'No projects' : 'No active projects'}
          message="A project is the durable thing work belongs to, and it outlives the sprints its issues are scheduled into."
        />
      ) : (
        <>
          {setStatus.error ? (
            <p role="alert" className="mb-3 text-sm text-blocked">
              {setStatus.error.message}
            </p>
          ) : null}
          <ul className="overflow-hidden rounded-[var(--radius-surface)] border border-grey-200">
            {query.data.projects.map((project) => (
            <li key={project.id} data-testid={`project-row-${project.key}`} className="border-t border-grey-200 px-3 py-3 first:border-t-0">
              <div className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_8rem_10rem] md:items-center">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="shrink-0 font-mono text-xs text-grey-500">{project.key}</span>
                  <span className="min-w-0 break-words text-sm font-medium text-ink">
                    {project.name}
                  </span>
                  {project.status === 'archived' ? (
                    <span className="shrink-0 text-xs text-grey-500">Archived</span>
                  ) : null}
                </div>
                <NavLink
                  to={`/w/${slug}/issues?project=${project.key}`}
                  className="text-sm underline"
                >
                  {openCount(project)} open
                </NavLink>
                {canWrite ? (
                  <div>
                    <Button
                      disabled={setStatus.isPending}
                      onClick={() => {
                        setStatus.reset()
                        if (project.status === 'archived') {
                          setStatus.mutate({ key: project.key, status: 'active' })
                        } else {
                          setArchivingKey(project.key)
                        }
                      }}
                    >
                      {project.status === 'archived'
                        ? setStatus.isPending && setStatus.variables?.key === project.key
                          ? 'Restoring…'
                          : 'Restore'
                        : 'Archive'}
                    </Button>
                  </div>
                ) : null}
              </div>
              {archivingKey === project.key ? (
                <div className="mt-3 space-y-2 border-t border-grey-200 pt-3">
                  <p className="text-sm font-medium">Archive {project.name}?</p>
                  <p className="text-sm text-grey-500">
                    It will be hidden from the active list. Its issues and history stay available.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="danger"
                      aria-label={`Confirm archive ${project.name}`}
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ key: project.key, status: 'archived' })}
                    >
                      {setStatus.isPending ? 'Archiving…' : 'Confirm archive'}
                    </Button>
                    <Button
                      disabled={setStatus.isPending}
                      onClick={() => {
                        setStatus.reset()
                        setArchivingKey(null)
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
