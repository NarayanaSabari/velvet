import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import type { Membership, Project } from '../../lib/types'
import { Button } from '../../ui/Button'
import { CopyField, RepoFileTabs } from './AgentSetup'
import { initCommand, installCommand, projectKeyFrom, repoFiles } from './repoFiles'

const controlClass = 'ui-control block min-h-11 w-full px-2 py-1 text-sm md:min-h-9'

/**
 * Connects a repository: install the CLI, run `velvet init` in the checkout,
 * and approve it in the browser for one project. The key it gets can reach
 * only that project. `velvet init` needs a project to pick, so an
 * organisation without one is offered an inline form first.
 */
export function RepoSetup({ workspace, baseUrl }: { workspace: Membership; baseUrl: string }) {
  const headingId = useId()
  const canWrite = workspace.role === 'admin' || workspace.role === 'member'
  const projects = useQuery({
    queryKey: ['projects', workspace.workspace_slug, false],
    queryFn: () => api.get<{ projects: Project[] }>(`/w/${workspace.workspace_slug}/projects`),
  })
  const [creating, setCreating] = useState(false)
  const active = (projects.data?.projects ?? []).filter((project) => project.status === 'active')

  return (
    <section aria-labelledby={headingId} className="space-y-4" data-testid="repo-setup">
      <div>
        <h3 id={headingId} className="font-medium">Connect a repository</h3>
        <p className="mt-1 text-sm text-grey-700">
          Your agent logs work with the <code>velvet</code> command. Each repository is linked to one project in{' '}
          {workspace.workspace_name}, and its key can reach only that project.
        </p>
      </div>

      {!canWrite ? (
        <p className="text-sm text-grey-700">
          You are a viewer in {workspace.workspace_name}, so you cannot connect a repository that writes. Ask an admin for member access.
        </p>
      ) : projects.isPending ? (
        <p role="status" className="text-sm text-grey-500">Loading projects…</p>
      ) : projects.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-blocked">Could not load projects.</p>
          <Button className="min-h-11" onClick={() => void projects.refetch()}>Try again</Button>
        </div>
      ) : active.length === 0 || creating ? (
        <div className="space-y-2 rounded-[var(--radius-surface)] border border-grey-200 p-4">
          <p className="text-sm font-medium">{active.length === 0 ? 'Create a project first' : 'New project'}</p>
          <p className="text-sm text-grey-700">A project is the durable home for a repository's work. You pick it when you run velvet init.</p>
          <NewProject
            slug={workspace.workspace_slug}
            onCancel={active.length > 0 ? () => setCreating(false) : undefined}
            onCreated={() => setCreating(false)}
          />
        </div>
      ) : (
        <ol className="space-y-4 text-sm">
          <li className="space-y-2">
            <p><span className="font-medium">1. Install the CLI</span> <span className="text-grey-500">once per machine.</span></p>
            <CopyField label="Install command" value={installCommand(baseUrl)} testId="cli-install" />
          </li>
          <li className="space-y-2">
            <p>
              <span className="font-medium">2. Link the repository</span>{' '}
              <span className="text-grey-500">from its folder. Your browser opens to approve it and pick the project.</span>
            </p>
            <CopyField label="Link command" value={initCommand(baseUrl)} testId="cli-init" />
            <p className="text-xs text-grey-500">
              This writes velvet.yaml, which holds no secret, so commit it. Teammates run the same command to get their own key.
              Projects: {active.map((project) => project.key).join(', ')}.{' '}
              <button type="button" className="underline underline-offset-4" onClick={() => setCreating(true)}>New project</button>
            </p>
          </li>
          <li className="space-y-2">
            <p>
              <span className="font-medium">3. Tell your agent to use it</span>{' '}
              <span className="text-grey-500">in a file it already reads. The same block suits every repository.</span>
            </p>
            <RepoFileTabs files={repoFiles()} />
          </li>
        </ol>
      )}

      <p className="text-xs text-grey-500">
        Manage projects on the <NavLink to={`/w/${workspace.workspace_slug}/projects`} className="underline">Projects</NavLink> page.
      </p>
    </section>
  )
}

export function NewProject({ slug, onCancel, onCreated }: {
  slug: string
  onCancel?: () => void
  onCreated: (project: Project) => void
}) {
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const create = useMutation({
    mutationFn: () => api.post<Project>(`/w/${slug}/projects`, { name: name.trim(), key: key.trim() }),
    onSuccess: async (project) => {
      await client.invalidateQueries({ queryKey: ['projects', slug] })
      onCreated(project)
    },
  })

  return (
    <form
      className="space-y-3"
      aria-label="New project"
      onSubmit={(event) => {
        event.preventDefault()
        if (!create.isPending) create.mutate()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-grey-500">Project name</span>
          <input
            className={controlClass}
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value)
              if (!keyEdited) setKey(projectKeyFrom(event.target.value))
            }}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-grey-500">Project key</span>
          <input
            className={`${controlClass} font-mono`}
            value={key}
            required
            placeholder="velvet"
            onChange={(event) => {
              setKeyEdited(true)
              setKey(event.target.value.toLowerCase())
            }}
          />
        </label>
      </div>
      <p className="text-xs text-grey-500">Lowercase letters, digits, and hyphens.</p>
      {create.error ? <p role="alert" className="text-sm text-blocked">{create.error.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" variant="primary" type="submit" disabled={create.isPending || !name.trim() || !key.trim()}>
          {create.isPending ? 'Creating…' : 'Create project'}
        </Button>
        {onCancel ? <Button className="min-h-11" onClick={onCancel} disabled={create.isPending}>Cancel</Button> : null}
      </div>
    </form>
  )
}
