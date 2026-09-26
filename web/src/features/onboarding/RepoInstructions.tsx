import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import type { Membership, Project } from '../../lib/types'
import { Button } from '../../ui/Button'
import { RepoFileTabs } from './AgentSetup'
import { projectKeyFrom, repoFiles } from './repoFiles'

const controlClass = 'ui-control block min-h-11 w-full px-2 py-1 text-sm md:min-h-9'

/**
 * Tells agents which project a repository's work belongs to. The hosted MCP
 * server cannot see the agent's checkout, so the person picks the project
 * here and pastes the generated block into a file the agent reads. The block
 * contains no key, so it can be committed and shared with the team.
 */
export function RepoInstructions({ workspace }: { workspace: Membership }) {
  const headingId = useId()
  const pickerId = useId()
  const canWrite = workspace.role === 'admin' || workspace.role === 'member'
  const projects = useQuery({
    queryKey: ['projects', workspace.workspace_slug, false],
    queryFn: () => api.get<{ projects: Project[] }>(`/w/${workspace.workspace_slug}/projects`),
  })
  const [chosen, setChosen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const list = projects.data?.projects ?? []
  const project = list.find((candidate) => candidate.key === chosen) ?? list[0] ?? null

  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid="repo-instructions-section">
      <div>
        <h3 id={headingId} className="font-medium">Tell your agent which project this repository is</h3>
        <p className="mt-1 text-sm text-grey-700">
          Your agent sees every project in {workspace.workspace_name}. Add this to a repository so it logs work there
          to the right project without asking. It contains no key, so it is safe to commit and share with your team.
        </p>
      </div>

      {projects.isPending ? (
        <p role="status" className="text-sm text-grey-500">Loading projects…</p>
      ) : projects.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-blocked">Could not load projects.</p>
          <Button className="min-h-11" onClick={() => void projects.refetch()}>Try again</Button>
        </div>
      ) : (
        <>
          {list.length > 0 && !creating ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-0 flex-1 basis-60 text-sm" htmlFor={pickerId}>
                <span className="mb-1 block text-xs text-grey-500">Project for this repository</span>
                <select
                  id={pickerId}
                  className={controlClass}
                  value={project?.key ?? ''}
                  onChange={(event) => setChosen(event.target.value)}
                >
                  {list.map((candidate) => (
                    <option key={candidate.id} value={candidate.key}>{candidate.name} ({candidate.key})</option>
                  ))}
                </select>
              </label>
              {canWrite ? (
                <Button className="min-h-11" onClick={() => setCreating(true)}>New project</Button>
              ) : null}
            </div>
          ) : null}

          {list.length === 0 && !creating ? (
            <div className="space-y-2 rounded-[var(--radius-surface)] border border-grey-200 p-4">
              <p className="text-sm font-medium">No projects yet</p>
              <p className="text-sm text-grey-700">
                A project is the durable home for a repository's work. Without one, your agent can only log against tickets.
              </p>
              {canWrite ? (
                <Button className="min-h-11" variant="primary" onClick={() => setCreating(true)}>Create a project</Button>
              ) : (
                <p className="text-sm text-grey-500">Ask an admin or member of {workspace.workspace_name} to create one.</p>
              )}
            </div>
          ) : null}

          {creating ? (
            <NewProject
              slug={workspace.workspace_slug}
              onCancel={() => setCreating(false)}
              onCreated={(created) => {
                setChosen(created.key)
                setCreating(false)
              }}
            />
          ) : null}

          {project && !creating ? (
            <RepoFileTabs
              files={repoFiles({
                workspaceName: workspace.workspace_name,
                workspaceSlug: workspace.workspace_slug,
                issuePrefix: workspace.issue_prefix,
                project,
              })}
            />
          ) : null}

          <p className="text-xs text-grey-500">
            Manage projects on the <NavLink to={`/w/${workspace.workspace_slug}/projects`} className="underline">Projects</NavLink> page.
          </p>
        </>
      )}
    </section>
  )
}

function NewProject({ slug, onCancel, onCreated }: {
  slug: string
  onCancel: () => void
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
      className="space-y-3 rounded-[var(--radius-surface)] border border-grey-200 p-4"
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
            autoFocus
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
      <p className="text-xs text-grey-500">Lowercase letters, digits, and hyphens. Agents name the project by this key.</p>
      {create.error ? <p role="alert" className="text-sm text-blocked">{create.error.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" variant="primary" type="submit" disabled={create.isPending || !name.trim() || !key.trim()}>
          {create.isPending ? 'Creating…' : 'Create project'}
        </Button>
        <Button className="min-h-11" onClick={onCancel} disabled={create.isPending}>Cancel</Button>
      </div>
    </form>
  )
}
