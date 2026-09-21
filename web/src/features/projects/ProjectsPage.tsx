import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import type { Project } from '../../lib/types'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'

/**
 * Projects are the durable unit of work inside an organisation. A milestone is
 * deleted with its sprint, so it cannot name something worked on across
 * several months; a project can.
 */

const controlClass =
  'min-h-10 w-full border border-grey-300 bg-paper px-1 py-0.5 text-sm text-ink md:min-h-8'

const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review'] as const

function openCount(project: Project): number {
  const counts = project.issue_counts ?? {}
  return OPEN_STATUSES.reduce((total, status) => total + (counts[status] ?? 0), 0)
}

function NewProjectForm({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
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
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['projects', slug] })
    },
    onError: (err: Error) => setError(err.message),
  })

  if (!open) {
    return <Button onClick={() => setOpen(true)}>New project</Button>
  }

  return (
    <form
      className="w-full max-w-md space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate()
      }}
    >
      <label className="block text-sm">
        Project name
        <input
          className={controlClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </label>
      <label className="block text-sm">
        Project key
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
        <Button type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function ProjectsPage({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const [includeArchived, setIncludeArchived] = useState(false)

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
      void queryClient.invalidateQueries({ queryKey: ['projects', slug] })
    },
  })

  return (
    <div className="max-w-[80rem] min-w-0">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg">Projects</h1>
        <NewProjectForm slug={slug} />
        <label className="flex items-center gap-2 text-sm text-grey-500">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          Show archived
        </label>
      </div>

      {query.isPending ? (
        <p role="status" className="text-grey-500">
          Loading projects…
        </p>
      ) : query.error ? (
        <p role="alert" className="text-blocked">
          Could not load projects.
        </p>
      ) : query.data.projects.length === 0 ? (
        <EmptyState
          title={includeArchived ? 'No projects' : 'No active projects'}
          message="A project is the durable thing work belongs to, and it outlives the sprints its issues are scheduled into."
        />
      ) : (
        <ul className="divide-y divide-grey-200 border-y border-grey-200">
          {query.data.projects.map((project) => (
            <li key={project.id} data-testid={`project-row-${project.key}`} className="px-2 py-3">
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
                <div>
                  <Button
                    disabled={setStatus.isPending}
                    onClick={() =>
                      setStatus.mutate({
                        key: project.key,
                        status: project.status === 'archived' ? 'active' : 'archived',
                      })
                    }
                  >
                    {project.status === 'archived' ? 'Restore' : 'Archive'}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
