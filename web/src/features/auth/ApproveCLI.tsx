import { useId, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { api, ApiError } from '../../lib/api'
import type { Project } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { PublicAuthPage } from './PublicAuthPage'
import { SignIn } from './SignIn'
import { SignOutButton } from './SignOutButton'
import { useSession } from './useSession'

interface PendingSignIn {
  id: string
  user_code: string
  client_name: string
  expires_at: string
}

function codeFromURL() {
  return new URLSearchParams(window.location.search).get('code') ?? ''
}

/**
 * Where `velvet init` sends the person. They confirm the code their terminal
 * shows, then bind the CLI to exactly one organisation and one project. The
 * key the CLI receives can reach nothing else, whatever velvet.yaml says.
 */
export function ApproveCLI() {
  const session = useSession()
  const [typed, setTyped] = useState(codeFromURL)
  const [code, setCode] = useState(codeFromURL)
  const codeId = useId()
  const orgId = useId()
  const projectId = useId()

  const writable = session.memberships.filter((m) => m.role !== 'viewer')
  // The person's explicit choice wins; until they make one, the first option
  // is selected. Deriving it avoids syncing state in an effect.
  const [chosenSlug, setSlug] = useState('')
  const [chosenProject, setProjectKey] = useState('')
  const slug = writable.some((m) => m.workspace_slug === chosenSlug) ? chosenSlug : (writable[0]?.workspace_slug ?? '')

  const pending = useQuery({
    queryKey: ['cli-session', code],
    queryFn: () => api.get<PendingSignIn>(`/cli/sessions/${encodeURIComponent(code)}`),
    enabled: session.isSignedIn && code !== '',
    retry: false,
  })
  const projects = useQuery({
    queryKey: ['projects', slug, false],
    queryFn: () => api.get<{ projects: Project[] }>(`/w/${slug}/projects`),
    enabled: session.isSignedIn && slug !== '',
  })
  const active = (projects.data?.projects ?? []).filter((p) => p.status === 'active')
  const projectKey = active.some((p) => p.key === chosenProject) ? chosenProject : (active[0]?.key ?? '')

  const approve = useMutation({
    mutationFn: () => api.post(`/cli/sessions/${encodeURIComponent(code)}/approve`, { workspace_slug: slug, project_key: projectKey }),
  })
  const deny = useMutation({
    mutationFn: () => api.post(`/cli/sessions/${encodeURIComponent(code)}/deny`, {}),
  })

  if (session.isLoading) return <PublicAuthPage title="Connect the Velvet CLI" note=""><p role="status" className="text-grey-500">Loading…</p></PublicAuthPage>
  if (!session.isSignedIn) return <SignIn message="Sign in to connect the Velvet CLI. Then run velvet init again, or reopen the link it printed." />

  const layout = (body: ReactNode) => (
    <PublicAuthPage title="Connect the Velvet CLI" note="" expanded>
      <div className="space-y-6">
        <p className="text-grey-700 [overflow-wrap:anywhere]">Signed in as {userLabel(session.user)}</p>
        {body}
        <SignOutButton publicStyle />
      </div>
    </PublicAuthPage>
  )

  if (approve.isSuccess) {
    return layout(
      <div role="status" className="space-y-2">
        <p className="text-base font-medium">Connected.</p>
        <p className="text-grey-700">Go back to your terminal. The CLI can now reach only <strong>{projectKey}</strong> in <strong>{slug}</strong>.</p>
      </div>,
    )
  }
  if (deny.isSuccess) {
    return layout(<p role="status" className="text-grey-700">Refused. The CLI was not given a key.</p>)
  }

  if (!code || pending.error) {
    const expired = pending.error instanceof ApiError && pending.error.status === 404
    return layout(
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setCode(typed.trim()) }}>
        {expired ? <p role="alert" className="text-blocked">That code has expired or was already used. Run velvet init again.</p> : null}
        <label htmlFor={codeId} className="block text-sm font-medium">Code shown in your terminal</label>
        <input
          id={codeId}
          className="block min-h-12 w-full rounded-[var(--radius-control)] border border-grey-300 bg-paper px-3 py-2 font-mono uppercase tracking-widest"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="ABCD-EFGH"
          autoComplete="off"
          required
        />
        <Button className="min-h-12" variant="primary" type="submit">Continue</Button>
      </form>,
    )
  }
  if (pending.isPending) return layout(<p role="status" className="text-grey-500">Checking the code…</p>)

  if (writable.length === 0) {
    return layout(<p role="alert" className="text-blocked">You are a viewer in every organisation, so you cannot connect an agent that writes. Ask an admin for member access.</p>)
  }

  const ready = slug !== '' && projectKey !== '' && !approve.isPending
  return layout(
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); if (ready) approve.mutate() }}>
      <div className="rounded-[var(--radius-surface)] border border-grey-200 p-4">
        <p className="text-sm text-grey-500">Confirm this matches your terminal</p>
        <p className="mt-1 font-mono text-lg tracking-widest" data-testid="cli-user-code">{pending.data.user_code}</p>
        <p className="mt-1 text-sm text-grey-500">{pending.data.client_name}</p>
      </div>

      <div className="space-y-1">
        <label htmlFor={orgId} className="block text-sm font-medium">Organisation</label>
        <select id={orgId} className="block min-h-12 w-full rounded-[var(--radius-control)] border border-grey-300 bg-paper px-3" value={slug}
          onChange={(e) => { setSlug(e.target.value); setProjectKey('') }}>
          {writable.map((m) => <option key={m.workspace_slug} value={m.workspace_slug}>{m.workspace_name}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor={projectId} className="block text-sm font-medium">Project</label>
        {projects.isPending ? <p role="status" className="text-grey-500">Loading projects…</p>
          : active.length === 0 ? <p className="text-grey-700">This organisation has no active projects. Create one in Velvet first.</p>
          : (
            <select id={projectId} className="block min-h-12 w-full rounded-[var(--radius-control)] border border-grey-300 bg-paper px-3" value={projectKey}
              onChange={(e) => setProjectKey(e.target.value)}>
              {active.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
            </select>
          )}
        <p className="text-xs text-grey-500">The CLI, and any agent using it in this repository, can read and write only this project.</p>
      </div>

      {approve.error ? <p role="alert" className="text-blocked">{approve.error.message}</p> : null}
      <div className="flex flex-wrap gap-3">
        <Button className="min-h-12" variant="primary" type="submit" disabled={!ready}>{approve.isPending ? 'Connecting…' : 'Connect'}</Button>
        <Button className="min-h-12" type="button" disabled={deny.isPending} onClick={() => deny.mutate()}>Refuse</Button>
      </div>
    </form>,
  )
}
