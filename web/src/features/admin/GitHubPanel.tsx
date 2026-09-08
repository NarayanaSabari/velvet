import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { Repo } from '../../lib/types'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'

export function GitHubPanel({
  slug,
  repos,
  isLoading,
  hasError,
}: {
  slug: string
  repos: Repo[]
  isLoading: boolean
  hasError: boolean
}) {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<string | null>(null)
  const connection = useQuery({
    queryKey: ['github', slug],
    queryFn: () => api.get<GitHubConnection>(`/w/${slug}/github`),
    refetchInterval: (query) => query.state.data?.status === 'syncing' ||
      (query.state.data?.status === 'suspended' && !query.state.data.error) ? 2000 : false,
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

  const verificationRequired = connection.data?.error === 'verification_required'
  const status = connection.data?.status
  useEffect(() => {
    if (status === 'connected') void queryClient.invalidateQueries({ queryKey: ['repos', slug] })
  }, [status, queryClient, slug])

  return (
    <section aria-labelledby="repositories-heading">
      <h2 id="repositories-heading" className="mb-3 border-b border-grey-200 pb-1 text-base">
        Repositories
      </h2>
      {connection.isPending ? <p className="text-grey-500">Loading GitHub connection…</p> : null}
      {connection.error ? <p role="alert" className="text-blocked">Could not load GitHub connection.</p> : null}
      <div className="mb-4 text-sm">
        {status === 'syncing' ? <p role="status">Syncing repositories…</p> : null}
        {status === 'connected' ? <p>Connected to {connection.data?.installation?.account_login}.</p> : null}
        {status === 'suspended' ? <p>{connection.data?.error === 'sync_failed'
          ? 'GitHub access is paused until its installation state can be verified.'
          : 'GitHub has suspended this installation. Restore it in GitHub to resume synchronization.'}</p> : null}
        {status === 'suspended' && connection.data?.error === 'sync_failed' ? <p role="alert">Could not check the installation in GitHub. Retry to check its current state.</p> : null}
        {verificationRequired ? <p>Verify ownership in GitHub before discovering repositories.</p> : null}
        {status === 'error' && !verificationRequired ? <p role="alert">{connection.data?.error === 'repository_conflict' ? 'A repository is connected to another organisation.' : 'Repository synchronization failed. Try again.'}</p> : null}
        {status === 'disconnected' || verificationRequired ? (
          <a className="underline" href={`/api/v1/w/${slug}/github/connect`}>
            {verificationRequired ? 'Verify GitHub ownership' : 'Connect GitHub'}
          </a>
        ) : null}
        {(status === 'error' && !verificationRequired) || status === 'connected' || (status === 'suspended' && connection.data?.error === 'sync_failed') ? (
          <Button className="mt-2" onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? 'Requesting sync…' : 'Retry sync'}
          </Button>
        ) : null}
      </div>

      {message ? <p className="mb-2 text-sm text-blocked" role="alert">{message}</p> : null}
      {isLoading ? <p className="text-grey-500">Loading repositories…</p> : null}
      {hasError ? <p className="text-blocked">Could not load repositories.</p> : null}
      {!isLoading && !hasError && repos.length === 0 ? (
        <EmptyState title="No repositories connected" message="Repositories appear after GitHub ownership is verified and synchronization completes." />
      ) : null}
      {!isLoading && !hasError && repos.length > 0 ? (
        <ul className="border-t border-grey-200">
          {repos.map((repo) => (
            <li key={repo.id} className="flex gap-3 border-b border-grey-200 px-2 py-2">
              <a
                className="min-w-0 flex-1 truncate underline"
                href={`https://github.com/${repo.owner}/${repo.name}`}
                target="_blank"
                rel="noreferrer"
              >
                {repo.owner}/{repo.name}
              </a>
              <span className="text-grey-500">{repo.default_branch}</span>
              <span className="text-grey-500">
                {repo.synced_at ? 'Synced' : 'Awaiting first sync'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

type GitHubConnection = {
  installation: { id: number; account_login: string } | null
  status: 'disconnected' | 'syncing' | 'connected' | 'suspended' | 'error'
  error: string | null
}
