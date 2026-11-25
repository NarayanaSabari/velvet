import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { FormDialog } from '../../ui/FormDialog'
import { ErrorNote } from '../../ui/ErrorNote'
import { Badge } from '@astryxdesign/core/Badge'
import { Card } from '@astryxdesign/core/Card'
import { Heading } from '../../ui/Heading'
import { Link } from '@astryxdesign/core/Link'
import { Text } from '@astryxdesign/core/Text'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import { formatDay } from '../../lib/formatDate'
import type { Project } from '../../lib/types'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { STATUS_LABELS } from '../../ui/StatusBadge'
import { sprintsQuery } from '../work/workLinks'
import { useSession } from '../auth/useSession'
import { CheckboxField, TextField } from '../../ui/fields'

/**
 * Projects are the durable unit of work inside an organisation. A milestone is
 * deleted with its sprint, so it cannot name something worked on across
 * several months; a project can.
 */


// In the order work moves through, most advanced first.
const OPEN_STATUSES = ['in_progress', 'in_review', 'todo', 'backlog'] as const

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
    <FormDialog
      title="New project"
      description="Create a durable home for work that spans several sprints."
      onClose={onClose}
      width="30rem"
    >
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate()
      }}
    >
      <TextField label="Project name" value={name} onChange={setName} required />
      <TextField
        label="Project key"
        description="Lowercase letters, digits, and hyphens. Agents name the project by this key."
        value={key}
        onChange={setKey}
        placeholder="velvet"
        required
      />
      {error ? (
        <ErrorNote>
          {error}
        </ErrorNote>
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
    </FormDialog>
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

  // For each card's current sprint. A failure here only leaves that line blank.
  const sprints = useQuery(sprintsQuery(slug))

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
        {canWrite ? (
          <Button variant="primary" onClick={() => setCreatingProject(true)}>New project</Button>
        ) : null}
        <CheckboxField label="Show archived" checked={includeArchived} onChange={setIncludeArchived} />
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
            <ErrorNote className="mb-3">
              {setStatus.error.message}
            </ErrorNote>
          ) : null}
          <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3" aria-label="Projects">
            {query.data.projects.map((project) => {
              const counts = project.issue_counts ?? {}
              const open = openCount(project)
              const projectSprints = (sprints.data?.sprints ?? []).filter((sprint) => sprint.project_id === project.id)
              const active = projectSprints.find((sprint) => sprint.state === 'active')
              const next = projectSprints
                .filter((sprint) => sprint.state === 'upcoming')
                .sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0]
              const archived = project.status === 'archived'
              return (
                <li key={project.id} data-project-card data-testid={`project-row-${project.key}`} className="min-w-0">
                  <Card padding={5} height="100%">
                    <section aria-labelledby={`project-${project.id}`} className="flex h-full flex-col">
                      <div className="flex items-baseline justify-between gap-3">
                        <Heading level={3} accessibilityLevel={2} id={`project-${project.id}`} className="min-w-0 break-words">{project.name}</Heading>
                        <span className="flex shrink-0 items-center gap-2">
                          {archived ? <Badge label="Archived" /> : null}
                          <Text type="code" color="secondary">{project.key}</Text>
                        </span>
                      </div>

                      {/* The one number that matters at a glance: a link to that open
                          work, with what it is made of beneath. */}
                      <div className="mt-4">
                        <NavLink
                          to={`/w/${slug}/issues?project=${encodeURIComponent(project.key)}&status=open`}
                          className="inline-flex items-baseline gap-2 text-grey-500 underline decoration-grey-300 underline-offset-4 hover:text-ink"
                        >
                          <span className="text-[2.5rem] leading-none font-semibold tabular-nums text-ink">{open}</span>{' '}
                          <span>open</span>
                        </NavLink>
                      </div>
                      <dl className="mt-4 grid grid-cols-4 gap-2 border-y border-grey-200 py-3">
                        {OPEN_STATUSES.map((status) => (
                          <div key={status} className="min-w-0">
                            <dd className="text-lg leading-tight font-semibold tabular-nums text-ink">{counts[status] ?? 0}</dd>
                            <dt><Text type="supporting" color="secondary">{STATUS_LABELS[status]}</Text></dt>
                          </div>
                        ))}
                      </dl>

                      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
                        <div className="min-w-0">
                          <Text as="p" type="supporting" color="secondary" display="block">Current sprint</Text>
                          <p className="mt-0.5">
                            {active ? (
                              <>
                                <Link href={`/w/${slug}/sprints/${active.id}`} color="primary" hasUnderline>{active.name}</Link>
                                <Text color="secondary"> · ends {formatDay(active.ends_on)}</Text>
                              </>
                            ) : (
                              <Text color="secondary">{next ? `Next: ${next.name}` : 'No sprint running'}</Text>
                            )}
                          </p>
                        </div>
                        {canWrite ? (
                          <Button
                            data-confirm-trigger
                            disabled={setStatus.isPending}
                            onClick={() => {
                              setStatus.reset()
                              if (archived) {
                                setStatus.mutate({ key: project.key, status: 'active' })
                              } else {
                                setArchivingKey(project.key)
                              }
                            }}
                          >
                            {archived
                              ? setStatus.isPending && setStatus.variables?.key === project.key
                                ? 'Restoring…'
                                : 'Restore'
                              : 'Archive'}
                          </Button>
                        ) : null}
                      </div>

                      <ConfirmDialog
                        open={archivingKey === project.key}
                        onClose={() => { setStatus.reset(); setArchivingKey(null) }}
                        title={`Archive ${project.name}?`}
                        description="It will be hidden from the active list. Its issues and history stay available."
                        actionLabel="Confirm archive"
                        pending={setStatus.isPending}
                        error={setStatus.error ? `${setStatus.error.message} Try again, or cancel.` : null}
                        onConfirm={() => setStatus.mutate({ key: project.key, status: 'archived' })}
                      />
                    </section>
                  </Card>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
