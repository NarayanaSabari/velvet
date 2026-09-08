import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useSession } from '../auth/useSession'
import { api } from '../../lib/api'
import type { Repo, Role, WorkspaceMembership } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'

const ROLES: Role[] = ['admin', 'member', 'viewer']

export function Admin({ slug }: { slug: string }) {
  const session = useSession(slug)
  const isAdmin = session.workspace?.role === 'admin'
  const members = useQuery({
    queryKey: ['memberships', slug],
    queryFn: () =>
      api.get<{ memberships: WorkspaceMembership[] }>(`/w/${slug}/memberships`),
    enabled: isAdmin,
  })
  const repos = useQuery({
    queryKey: ['repos', slug],
    queryFn: () => api.get<{ repos: Repo[] }>(`/w/${slug}/repos`),
    enabled: isAdmin,
  })

  if (session.isLoading) return <p className="text-grey-500">Loading…</p>
  if (!isAdmin) {
    return (
      <EmptyState
        title="Admin access required"
        message="Only workspace admins can manage members and repository connections."
      />
    )
  }

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-lg">Administration</h1>
      <p className="mb-6 text-grey-500">
        Manage who can enter this workspace and which GitHub repositories supply work evidence.
      </p>

      <MembershipPanel
        slug={slug}
        memberships={members.data?.memberships ?? []}
        isLoading={members.isPending}
        hasError={Boolean(members.error)}
      />
      <RepositoryPanel
        slug={slug}
        repos={repos.data?.repos ?? []}
        isLoading={repos.isPending}
        hasError={Boolean(repos.error)}
      />
    </div>
  )
}

function MembershipPanel({
  slug,
  memberships,
  isLoading,
  hasError,
}: {
  slug: string
  memberships: WorkspaceMembership[]
  isLoading: boolean
  hasError: boolean
}) {
  const queryClient = useQueryClient()
  const [login, setLogin] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [message, setMessage] = useState<string | null>(null)

  const invite = useMutation({
    mutationFn: () =>
      api.post<WorkspaceMembership>(`/w/${slug}/memberships`, {
        github_login: login.trim(),
        role,
      }),
    onSuccess: () => {
      setLogin('')
      setRole('member')
      setMessage(null)
      void queryClient.invalidateQueries({ queryKey: ['memberships', slug] })
    },
    onError: (error: Error) => setMessage(error.message),
  })

  const updateRole = useMutation({
    mutationFn: ({ id, role: nextRole }: { id: string; role: Role }) =>
      api.patch<WorkspaceMembership>(`/w/${slug}/memberships/${id}`, { role: nextRole }),
    onSuccess: () => {
      setMessage(null)
      void queryClient.invalidateQueries({ queryKey: ['memberships', slug] })
      void queryClient.invalidateQueries({ queryKey: ['session'] })
    },
    onError: (error: Error) => {
      setMessage(error.message)
      void queryClient.invalidateQueries({ queryKey: ['memberships', slug] })
    },
  })

  return (
    <section className="mb-8" aria-labelledby="members-heading">
      <h2 id="members-heading" className="mb-3 border-b border-grey-200 pb-1 text-base">
        Members
      </h2>

      <form
        className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]"
        onSubmit={(event) => {
          event.preventDefault()
          if (login.trim()) invite.mutate()
        }}
      >
        <label>
          <span className="mb-0.5 block text-xs text-grey-500">GitHub login</span>
          <input
            className="w-full border border-grey-300 bg-paper px-2 py-1"
            value={login}
            onChange={(event) => {
              setLogin(event.target.value)
              setMessage(null)
            }}
            autoComplete="off"
            required
          />
        </label>
        <label>
          <span className="mb-0.5 block text-xs text-grey-500">Invite role</span>
          <select
            className="w-full border border-grey-300 bg-paper px-2 py-1"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <Button
          className="self-end"
          variant="primary"
          type="submit"
          disabled={!login.trim() || invite.isPending}
        >
          {invite.isPending ? 'Inviting…' : 'Send invite'}
        </Button>
      </form>

      {message ? <p className="mb-2 text-sm text-blocked" role="alert">{message}</p> : null}
      {isLoading ? <p className="text-grey-500">Loading members…</p> : null}
      {hasError ? <p className="text-blocked">Could not load members.</p> : null}
      {!isLoading && !hasError ? (
        <ul className="border-t border-grey-200">
          {memberships.map((membership) => (
            <li
              key={membership.id}
              className="flex items-center gap-3 border-b border-grey-200 px-2 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{membership.user ? userLabel(membership.user) : `@${membership.invited_login}`}</div>
                {!membership.user ? <div className="text-xs text-grey-500">Invite pending</div> : null}
                {membership.user?.github_login && userLabel(membership.user) !== `@${membership.user.github_login}` ? (
                  <div className="text-xs text-grey-500">@{membership.user.github_login}</div>
                ) : null}
              </div>
              <label>
                <span className="sr-only">Role for {membership.user ? userLabel(membership.user) : membership.invited_login}</span>
                <select
                  className="border border-grey-300 bg-paper px-2 py-1 text-sm"
                  value={membership.role}
                  disabled={updateRole.isPending}
                  onChange={(event) =>
                    updateRole.mutate({
                      id: membership.id,
                      role: event.target.value as Role,
                    })
                  }
                >
                  {ROLES.map((value) => (
                    <option key={value} value={value}>
                      {roleLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function RepositoryPanel({
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
    refetchInterval: (query) => query.state.data?.status === 'syncing' ? 2000 : false,
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
        {status === 'suspended' ? <p>GitHub has suspended this installation. Restore it in GitHub to resume synchronization.</p> : null}
        {verificationRequired ? <p>Verify ownership in GitHub before discovering repositories.</p> : null}
        {status === 'error' && !verificationRequired ? <p role="alert">{connection.data?.error === 'repository_conflict' ? 'A repository is connected to another organisation.' : 'Repository synchronization failed. Try again.'}</p> : null}
        {status === 'disconnected' || verificationRequired ? (
          <a className="underline" href={`/api/v1/w/${slug}/github/connect`}>
            {verificationRequired ? 'Verify GitHub ownership' : 'Connect GitHub'}
          </a>
        ) : null}
        {(status === 'error' && !verificationRequired) || status === 'connected' ? (
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

function roleLabel(role: Role) {
  return role.charAt(0).toUpperCase() + role.slice(1)
}
