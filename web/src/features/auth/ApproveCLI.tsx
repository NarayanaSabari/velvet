import { useEffect, useId, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { api, ApiError } from '../../lib/api'
import type { Project } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { NewProject } from '../onboarding/RepoSetup'
import { PublicAuthPage } from './PublicAuthPage'
import { SignIn } from './SignIn'
import { SignOutButton } from './SignOutButton'
import { useSession } from './useSession'

interface PendingSignIn {
  id: string
  user_code: string
  client_name: string
  expires_at: string
  flow?: 'login' | 'init' | 'manage' | 'desktop'
}

function codeFromURL() {
  return new URLSearchParams(window.location.search).get('code') ?? ''
}

/**
 * Where `velvet login` requests explicit device consent. Legacy init sessions
 * still bind a repository key to one organisation and one project.
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
  const [creating, setCreating] = useState(false)
  const slug = writable.some((m) => m.workspace_slug === chosenSlug) ? chosenSlug : (writable[0]?.workspace_slug ?? '')

  const pending = useQuery({
    queryKey: ['cli-session', code],
    queryFn: () => api.get<PendingSignIn>(`/cli/sessions/${encodeURIComponent(code)}`),
    enabled: session.isSignedIn && code !== '',
    retry: false,
  })
  const login = pending.data?.flow === 'login'
  const manage = pending.data?.flow === 'manage'
  const desktop = pending.data?.flow === 'desktop'
  const unscoped = login || manage || desktop
  const legacyInit = pending.isSuccess && (pending.data.flow === undefined || pending.data.flow === 'init')
  // Expiry is tracked per deadline so a new code starts unexpired, and the page
  // flips to expired on time instead of on the next unrelated render.
  const expiresAt = pending.data ? Date.parse(pending.data.expires_at) : NaN
  const [expiredAt, setExpiredAt] = useState<number>()
  const expired = expiredAt === expiresAt
  useEffect(() => {
    const delay = expiresAt - Date.now()
    // Beyond setTimeout's 32-bit limit the timer would fire immediately.
    if (Number.isNaN(delay) || delay > 2 ** 31 - 1) return
    const timer = setTimeout(() => setExpiredAt(expiresAt), Math.max(delay, 0))
    return () => clearTimeout(timer)
  }, [expiresAt])
  const projects = useQuery({
    queryKey: ['projects', slug, false],
    queryFn: () => api.get<{ projects: Project[] }>(`/w/${slug}/projects`),
    enabled: session.isSignedIn && legacyInit && slug !== '',
  })
  const active = (projects.data?.projects ?? []).filter((p) => p.status === 'active')
  const projectKey = active.some((p) => p.key === chosenProject) ? chosenProject : (active[0]?.key ?? '')

  const approve = useMutation({
    mutationFn: () => api.post(`/cli/sessions/${encodeURIComponent(code)}/approve`, unscoped ? {} : { workspace_slug: slug, project_key: projectKey }),
  })
  const deny = useMutation({
    mutationFn: () => api.post(`/cli/sessions/${encodeURIComponent(code)}/deny`, {}),
  })

  if (session.isLoading) return <PublicAuthPage title="Connect the Velvet CLI" note=""><p role="status" className="text-grey-500">Loading…</p></PublicAuthPage>
  if (session.error) return <PublicAuthPage title="Connect the Velvet CLI" note=""><p role="alert" className="text-blocked">{session.error.message} Reload to try again.</p></PublicAuthPage>
  if (!session.isSignedIn) return <SignIn returnTo={code ? `/cli/approve?${new URLSearchParams({ code })}` : undefined} message="Sign in to review this device request. Signing in does not approve it." />

  const layout = (body: ReactNode) => (
    <PublicAuthPage title={desktop ? 'Connect Velvet for macOS' : 'Connect the Velvet CLI'} note="" expanded>
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
        {desktop ? <p className="text-grey-700">Go back to Velvet for macOS. The app is connected with your current memberships and roles.</p> : manage ? <p className="text-grey-700">Go back to your terminal. Account management is connected with your current memberships and roles.</p> : login ? <p className="text-grey-700">Go back to your terminal and run velvet init in your repository to choose an organisation and project.</p> : <p className="text-grey-700">Go back to your terminal. The CLI can now reach only <strong>{projectKey}</strong> in <strong>{slug}</strong>.</p>}
      </div>,
    )
  }
  if (deny.isSuccess) {
    return layout(<p role="status" className="text-grey-700">{desktop ? 'Refused. The desktop app was not given a key.' : 'Refused. The CLI was not given a key.'}</p>)
  }

  if (!code || pending.error) {
    const expired = pending.error instanceof ApiError && [404, 410].includes(pending.error.status)
    return layout(
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const next = typed.trim().toUpperCase(); if (next === code) void pending.refetch(); else setCode(next); approve.reset(); deny.reset() }}>
        {expired ? <p role="alert" className="text-blocked">That code has expired or was already used. Run velvet login again, or velvet init for a legacy repository request.</p> : null}
        {pending.error && !expired ? <p role="alert" className="text-blocked">{pending.error.message} Try checking the code again.</p> : null}
        <label htmlFor={codeId} className="block text-sm font-medium">Code shown on your device</label>
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

  if (!unscoped && !legacyInit) return layout(<p role="alert" className="text-blocked">This CLI request is not supported. Update the CLI and run velvet login again.</p>)

  if (!unscoped && writable.length === 0) {
    return layout(<p role="alert" className="text-blocked">You are a viewer in every organisation, so you cannot connect an agent that writes. Ask an admin for member access.</p>)
  }

  const busy = approve.isPending || deny.isPending
  const ready = (unscoped || (slug !== '' && projectKey !== '' && !creating)) && !busy && !expired
  return layout(
    <div className="space-y-5">
      <div className="rounded-[var(--radius-surface)] border border-grey-200 p-4">
        <p className="text-sm text-grey-500">{desktop ? 'Confirm this matches Velvet for macOS' : 'Confirm this matches your terminal'}</p>
        <p className="mt-1 break-all font-mono text-lg tracking-widest" data-testid="cli-user-code">{pending.data.user_code}</p>
        <p className="mt-1 text-sm text-grey-500 [overflow-wrap:anywhere]">{pending.data.client_name}</p>
      </div>

      {desktop ? <p className="text-sm text-grey-700">Approve only if you started sign-in in Velvet for macOS on your device. This gives the desktop app normal account access across all your current and future organisation memberships, limited by your current roles. It can read your work, create and update tickets, and manage settings where your role allows it. This is not a repository or setup key. Do not share this credential with agents. You can revoke it under Profile &gt; API tokens.</p> : manage ? <p className="text-sm text-grey-700">Approve only if you started velvet admin login on this device. This grants account-wide management access using a personal credential, limited by your current organisation memberships and roles. It can manage account settings and organisations where your role allows it. This is separate from normal velvet login setup access and is not limited to one project. Do not share this credential with repository agents.</p> : login ? <p className="text-sm text-grey-700">Approve only if you started velvet login on this device. This gives the CLI a setup credential to list and create organisations and projects, and create repository keys where you have write access. Routine work uses a separate key scoped to the chosen project. No repository is connected yet.</p> : <>
      <div className="space-y-1">
        <label htmlFor={orgId} className="block text-sm font-medium">Organisation</label>
        <select id={orgId} className="block min-h-12 w-full rounded-[var(--radius-control)] border border-grey-300 bg-paper px-3" value={slug}
          onChange={(e) => { setSlug(e.target.value); setProjectKey(''); setCreating(false) }}>
          {writable.map((m) => <option key={m.workspace_slug} value={m.workspace_slug}>{m.workspace_name}</option>)}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor={projectId} className="block text-sm font-medium">Project</label>
        {projects.isPending ? <p role="status" className="text-grey-500">Loading projects…</p>
          : projects.error ? <p role="alert" className="text-blocked">Could not load projects.</p>
          : active.length === 0 || creating ? (
            <div className="space-y-2 rounded-[var(--radius-surface)] border border-grey-200 p-4">
              <p className="text-sm text-grey-700">{active.length === 0 ? 'This organisation has no active projects. Create one to connect.' : 'New project'}</p>
              <NewProject
                slug={slug}
                onCancel={active.length > 0 ? () => setCreating(false) : undefined}
                onCreated={(p) => { setProjectKey(p.key); setCreating(false) }}
              />
            </div>
          )
          : (
            <>
              <select id={projectId} className="block min-h-12 w-full rounded-[var(--radius-control)] border border-grey-300 bg-paper px-3" value={projectKey}
                onChange={(e) => setProjectKey(e.target.value)}>
                {active.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
              </select>
              <button type="button" className="text-sm underline underline-offset-4" onClick={() => setCreating(true)}>New project</button>
            </>
          )}
        <p className="text-xs text-grey-500">The CLI, and any agent using it in this repository, can read and write only this project.</p>
      </div>

      </>}
      {deny.error ? <p role="alert" className="text-blocked">{deny.error.message}</p> : null}
      {expired ? <p role="alert" className="text-blocked">{desktop ? 'This request expired. Start sign-in again in Velvet for macOS.' : 'This request expired. Run velvet login again.'}</p> : null}
      {approve.error ? <p role="alert" className="text-blocked">{approve.error.message}</p> : null}
      <form className="flex flex-wrap gap-3" aria-label={desktop ? 'Connect the desktop app' : 'Connect the CLI'} onSubmit={(e) => { e.preventDefault(); if (ready) approve.mutate() }}>
        <Button className="min-h-12" variant="primary" type="submit" disabled={!ready}>{approve.isPending ? 'Connecting…' : desktop ? 'Approve desktop app' : manage ? 'Approve account management' : login ? 'Approve login' : 'Connect'}</Button>
        <Button className="min-h-12" type="button" disabled={busy} onClick={() => deny.mutate()}>Refuse</Button>
      </form>
    </div>,
  )
}
