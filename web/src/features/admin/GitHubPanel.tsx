import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import type { Project, Repo } from '../../lib/types'
import { Button } from '../../ui/Button'
import { buttonClassName } from '../../ui/buttonStyles'
import { EmptyState } from '../../ui/EmptyState'
import { SectionHeader } from '../../ui/PageHeader'
import { LoadingState } from '../../ui/QueryState'
import { RelativeTime } from '../../ui/RelativeTime'

type GitHubConnection = {
  installation: { id: number; account_login: string; repos_synced_at?: string | null } | null
  status: 'disconnected' | 'syncing' | 'connected' | 'suspended' | 'error'
  error: string | null
}

function repoState(repo: Repo): { label: string; tone: string } {
  if (repo.disconnected_at) return { label: 'Disconnected', tone: 'text-grey-500' }
  if (repo.synced_at) return { label: 'Synced', tone: 'text-grey-500' }
  return { label: 'Awaiting first sync', tone: 'text-stale' }
}

/** A dot plus words, so the state never depends on the colour alone. */
function StatusDot({ tone }: { tone: 'done' | 'stale' | 'blocked' | 'idle' }) {
  const colour = { done: 'bg-done', stale: 'bg-stale', blocked: 'bg-blocked', idle: 'bg-grey-300' }[tone]
  return <span aria-hidden="true" className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${colour}`} />
}

export function GitHubPanel({ slug, repos }: {
  slug: string
  repos: UseQueryResult<{ repos: Repo[] }>
}) {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<string | null>(null)
  const connection = useQuery({
    queryKey: ['github', slug],
    queryFn: () => api.get<GitHubConnection>(`/w/${slug}/github`),
    refetchInterval: (query) => query.state.data?.status === 'syncing' ||
      (query.state.data?.status === 'suspended' && !query.state.data.error) ? 2000 : false,
  })
  const projects = useQuery({
    queryKey: ['projects', slug, false],
    queryFn: () => api.get<{ projects: Project[] }>(`/w/${slug}/projects`),
  })
  const retry = useMutation({
    mutationFn: () => api.post(`/w/${slug}/github/sync`),
    onSuccess: () => {
      setMessage(null)
      void queryClient.invalidateQueries({ queryKey: ['github', slug] })
      void queryClient.invalidateQueries({ queryKey: ['repos', slug] })
    },
    onError: (error: Error) => setMessage(error.message),
  })
  const mapProject = useMutation({
    mutationFn: ({ repo, projectId }: { repo: Repo; projectId: string | null }) =>
      api.put(`/w/${slug}/repos/${repo.id}/project`, { project_id: projectId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['repos', slug] }),
  })

  const verificationRequired = connection.data?.error === 'verification_required'
  const status = connection.data?.status
  const account = connection.data?.installation?.account_login
  const syncedAt = connection.data?.installation?.repos_synced_at
  useEffect(() => {
    if (status === 'connected') void queryClient.invalidateQueries({ queryKey: ['repos', slug] })
  }, [status, queryClient, slug])

  const list = repos.data?.repos ?? []
  const live = list.filter((repo) => !repo.disconnected_at).length
  const projectList = projects.data?.projects ?? []
  const canRetry = (status === 'error' && !verificationRequired) || status === 'connected' ||
    (status === 'suspended' && connection.data?.error === 'sync_failed')

  let tone: 'done' | 'stale' | 'blocked' | 'idle' = 'idle'
  if (status === 'connected') tone = 'done'
  else if (status === 'syncing' || status === 'suspended' || verificationRequired) tone = 'stale'
  else if (status === 'error') tone = 'blocked'

  return (
    <section id="repositories" className="mb-10 scroll-mt-4" aria-labelledby="repositories-heading">
      <SectionHeader id="repositories-heading" title="Repositories" meta={repos.data && list.length > 0 ? `${live} connected` : undefined} />
      <p className="mb-3 max-w-[46rem] text-sm text-grey-500">
        GitHub supplies pull requests and commits as evidence of work. Velvet only reads from GitHub and never changes a ticket because of it.
      </p>

      {connection.isPending ? <LoadingState label="Loading GitHub connection…" /> : null}
      {connection.error ? <p role="alert" className="text-sm text-blocked">Could not load GitHub connection.</p> : null}

      {connection.data ? (
        <div className="mb-4 rounded-[var(--radius-surface)] border border-grey-200 p-4 text-sm" data-testid="github-status">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
              <StatusDot tone={tone} />
              <div className="min-w-0 space-y-1">
                {status === 'syncing' ? <p role="status" className="font-medium">Syncing repositories…</p> : null}
                {status === 'connected' ? (
                  <>
                    <p className="font-medium [overflow-wrap:anywhere]">Connected to {account}.</p>
                    {syncedAt ? <p className="text-grey-500">Repositories last synced <RelativeTime iso={syncedAt} />.</p> : null}
                  </>
                ) : null}
                {status === 'suspended' ? <p className="font-medium">{connection.data.error === 'sync_failed'
                  ? 'GitHub access is paused until its installation state can be verified.'
                  : 'GitHub has suspended this installation. Restore it in GitHub to resume synchronization.'}</p> : null}
                {status === 'suspended' && connection.data.error === 'sync_failed' ? <p role="alert">Could not check the installation in GitHub. Retry to check its current state.</p> : null}
                {verificationRequired ? <p className="font-medium">Verify ownership in GitHub before discovering repositories.</p> : null}
                {status === 'error' && !verificationRequired ? <p role="alert" className="font-medium">{connection.data.error === 'repository_conflict' ? 'A repository is connected to another organisation.' : 'Repository synchronization failed. Try again.'}</p> : null}
                {status === 'disconnected' ? (
                  <>
                    <p className="font-medium">GitHub is not connected.</p>
                    <p className="text-grey-500">Connect it to see pull requests and commits next to the tickets they mention.</p>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {status === 'disconnected' || verificationRequired ? (
                <a className={buttonClassName('primary', 'inline-flex min-h-10 items-center no-underline md:min-h-8')} href={`/api/v1/w/${slug}/github/connect`}>
                  {verificationRequired ? 'Verify GitHub ownership' : 'Connect GitHub'}
                </a>
              ) : null}
              {canRetry ? (
                <Button className="min-h-10 md:min-h-8" onClick={() => retry.mutate()} disabled={retry.isPending}>
                  {retry.isPending ? 'Requesting sync…' : 'Retry sync'}
                </Button>
              ) : null}
            </div>
          </div>
          {connection.data.installation ? (
            <details className="mt-3 border-t border-grey-200 pt-3">
              <summary className="inline-flex min-h-8 cursor-pointer items-center underline underline-offset-4">Disconnect GitHub</summary>
              <p className="mt-2">To disconnect, uninstall the App in the GitHub account where it is installed. Your existing work evidence remains available.</p>
              <a className="mt-2 block underline" href="https://github.com/settings/installations" target="_blank" rel="noreferrer">Open GitHub App settings</a>
              <p className="mt-2 text-grey-500">For an organisation installation, open that organisation’s settings as an owner.</p>
              <a className="underline" href="https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps" target="_blank" rel="noreferrer">Organisation uninstall instructions</a>
            </details>
          ) : null}
        </div>
      ) : null}

      {message ? <p className="mb-2 text-sm text-blocked" role="alert">{message}</p> : null}
      {mapProject.error ? <p className="mb-2 text-sm text-blocked" role="alert">{mapProject.error.message}</p> : null}
      {repos.isPending ? <LoadingState label="Loading repositories…" /> : null}
      {repos.error ? <p role="alert" className="text-sm text-blocked">Could not load repositories.</p> : null}
      {repos.data && list.length === 0 ? (
        <EmptyState title="No repositories connected" message="Repositories appear after GitHub ownership is verified and synchronization completes." />
      ) : null}

      {list.length > 0 ? (
        <>
          <p className="mb-2 max-w-[46rem] text-xs text-grey-500">
            A repository’s project is where its pull requests and commits are filed when they mention no ticket, and
            where agents working in it log by default. Manage projects on the{' '}
            <NavLink to={`/w/${slug}/projects`} className="underline">Projects</NavLink> page.
          </p>
          <ul className="overflow-hidden rounded-[var(--radius-surface)] border border-grey-200">
            {list.map((repo) => {
              const state = repoState(repo)
              const full = `${repo.owner}/${repo.name}`
              const saving = mapProject.isPending && mapProject.variables?.repo.id === repo.id
              return (
                <li key={repo.id} className="border-t border-grey-200 px-3 py-3 first:border-t-0" data-testid={`repo-${repo.name}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1 basis-56">
                      <a
                        className={`underline [overflow-wrap:anywhere] ${repo.disconnected_at ? 'text-grey-500' : ''}`}
                        href={`https://github.com/${repo.owner}/${repo.name}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {full}
                      </a>
                      <div className="flex flex-wrap gap-x-2 text-xs text-grey-500">
                        <span className="font-mono">{repo.default_branch}</span>
                        <span aria-hidden="true">·</span>
                        <span className={state.tone}>{state.label}</span>
                        {repo.synced_at && !repo.disconnected_at ? <span><RelativeTime iso={repo.synced_at} /></span> : null}
                      </div>
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-sm">
                      <span className="text-xs text-grey-500">Project</span>
                      <select
                        className="ui-control min-h-10 max-w-[14rem] px-2 py-1 text-sm md:min-h-8"
                        aria-label={`Project for ${full}`}
                        value={repo.project_id ?? ''}
                        disabled={saving || projects.isPending}
                        onChange={(event) => { mapProject.reset(); mapProject.mutate({ repo, projectId: event.target.value || null }) }}
                      >
                        <option value="">No project</option>
                        {projectList.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                        {repo.project_id && !projectList.some((project) => project.id === repo.project_id) && projects.data ? (
                          <option value={repo.project_id}>Archived project</option>
                        ) : null}
                      </select>
                      {saving ? <span role="status" className="text-xs text-grey-500">Saving…</span> : null}
                    </label>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      ) : null}
    </section>
  )
}
