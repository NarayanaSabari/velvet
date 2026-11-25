import { ErrorNote } from '../../ui/ErrorNote'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { Button as AstryxButton } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'

import { NavLink } from '../../app/nav'
import { api } from '../../lib/api'
import type { Project, Repo } from '../../lib/types'
import { Button } from '../../ui/Button'
import { PanelHeading } from '../../ui/PageHeader'
import { EmptyState } from '../../ui/EmptyState'
import { LoadingState } from '../../ui/QueryState'
import { RelativeTime } from '../../ui/RelativeTime'
import { SelectField } from '../../ui/fields'

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
    <section aria-label="Repositories">
      <Text as="p" color="secondary" display="block" className="mb-4 max-w-[46rem]">GitHub installation is optional. Velvet members can create, comment on, and view work without GitHub access, and viewers are read-only. Connecting repositories shares their synced evidence with all Velvet members and viewers in this organisation, even without GitHub repository permissions.</Text>
      {connection.isPending ? <LoadingState label="Loading GitHub connection…" /> : null}
      {connection.error ? <ErrorNote>Could not load GitHub connection.</ErrorNote> : null}

      {connection.data ? (
        <div className="mb-4" data-testid="github-status">
        <Card padding={5}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
              <StatusDot tone={tone} />
              <div className="min-w-0 space-y-1">
                {status === 'syncing' ? <LoadingState className="">Syncing repositories…</LoadingState> : null}
                {status === 'connected' ? (
                  <>
                    <p className="font-medium [overflow-wrap:anywhere]">Connected to {account}.</p>
                    {syncedAt ? <p className="text-grey-500">Repositories last synced <RelativeTime iso={syncedAt} />.</p> : null}
                  </>
                ) : null}
                {status === 'suspended' ? <p className="font-medium">{connection.data.error === 'sync_failed'
                  ? 'GitHub access is paused until its installation state can be verified.'
                  : 'GitHub has suspended this installation. Restore it in GitHub to resume synchronization.'}</p> : null}
                {status === 'suspended' && connection.data.error === 'sync_failed' ? <ErrorNote>Could not check the installation in GitHub. Retry to check its current state.</ErrorNote> : null}
                {verificationRequired ? <p className="font-medium">Verify ownership in GitHub before discovering repositories.</p> : null}
                {status === 'error' && !verificationRequired ? <ErrorNote>{connection.data.error === 'repository_conflict' ? 'A repository is connected to another organisation.' : 'Repository synchronization failed. Try again.'}</ErrorNote> : null}
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
                <AstryxButton
                  variant="primary"
                  href={`/api/v1/w/${slug}/github/connect`}
                  label={verificationRequired ? 'Verify GitHub ownership' : 'Connect GitHub'}
                />
              ) : null}
              {canRetry ? (
                <Button className="min-h-10 md:min-h-8" onClick={() => retry.mutate()} disabled={retry.isPending}>
                  {retry.isPending ? 'Requesting sync…' : 'Retry sync'}
                </Button>
              ) : null}
            </div>
          </div>
          {connection.data.installation ? (
            <div className="mt-3 border-t border-grey-200 pt-3">
            <Collapsible defaultIsOpen={false} chevronPosition="start" trigger={<span className="py-1.5"><Text color="secondary">Disconnect GitHub</Text></span>}>
              <p className="mt-2">To disconnect, uninstall the App in the GitHub account where it is installed. Your existing work evidence remains available.</p>
              <a className="mt-2 flex min-h-11 items-center underline sm:block sm:min-h-0" href="https://github.com/settings/installations" target="_blank" rel="noreferrer">Open GitHub App settings</a>
              <p className="mt-2 text-grey-500">For an organisation installation, open that organisation’s settings as an owner.</p>
              <a className="underline" href="https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps" target="_blank" rel="noreferrer">Organisation uninstall instructions</a>
            </Collapsible>
            </div>
          ) : null}
        </Card>
        </div>
      ) : null}

      {message ? <ErrorNote className="mb-2">{message}</ErrorNote> : null}
      {mapProject.error ? <ErrorNote className="mb-2">{mapProject.error.message}</ErrorNote> : null}
      {repos.isPending ? <LoadingState label="Loading repositories…" /> : null}
      {repos.error ? <ErrorNote>Could not load repositories.</ErrorNote> : null}
      {repos.data && list.length === 0 ? (
        <EmptyState title="No repositories connected" message="Repositories appear after GitHub ownership is verified and synchronization completes." />
      ) : null}

      {list.length > 0 ? (
        <>
          <PanelHeading className="mb-1">{live} connected {live === 1 ? 'repository' : 'repositories'}</PanelHeading>
          <p className="mb-2 max-w-[46rem] text-sm text-grey-500">
            A repository’s project is where its pull requests and commits are filed when they mention no ticket, and
            where agents working in it log by default. Manage projects on the{' '}
            <NavLink to={`/w/${slug}/projects`} className="underline">Projects</NavLink> page.
          </p>
          <div className="border-y border-grey-200">
          <List hasDividers density="balanced" edge="flush" aria-label="Repositories">
            {list.map((repo) => {
              const state = repoState(repo)
              const full = `${repo.owner}/${repo.name}`
              const saving = mapProject.isPending && mapProject.variables?.repo.id === repo.id
              return (
                <ListItem key={repo.id} itemKey={repo.id} data-testid={`repo-${repo.name}`} label={(
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-1">
                    <div className="min-w-0 flex-1 basis-56">
                      <a
                        className={`inline-flex min-h-11 items-center underline [overflow-wrap:anywhere] sm:min-h-0 ${repo.disconnected_at ? 'text-grey-500' : ''}`}
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
                    <div className="flex shrink-0 items-end gap-2 text-sm">
                      <SelectField
                        className="w-56"
                        label="Project"
                        aria-label={`Project for ${full}`}
                        value={repo.project_id ?? ''}
                        disabled={saving || projects.isPending}
                        onChange={(value) => { mapProject.reset(); mapProject.mutate({ repo, projectId: value || null }) }}
                        options={[
                          { value: '', label: 'No project' },
                          ...projectList.map((project) => ({ value: project.id, label: project.name })),
                          ...(repo.project_id && !projectList.some((project) => project.id === repo.project_id) && projects.data
                            ? [{ value: repo.project_id, label: 'Archived project' }]
                            : []),
                        ]}
                      />
                      {saving ? <LoadingState className="mb-2">Saving…</LoadingState> : null}
                    </div>
                  </div>
                )} />
              )
            })}
          </List>
          </div>
        </>
      ) : null}
    </section>
  )
}
