import { LoadingState } from '../../ui/QueryState'
import { ErrorNote } from '../../ui/ErrorNote'
import { Card } from '@astryxdesign/core/Card'
import { Link } from '@astryxdesign/core/Link'
import { Text } from '@astryxdesign/core/Text'

import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { api, ApiError } from '../../lib/api'
import type { Project } from '../../lib/types'
import { Button } from '../../ui/Button'
import { NewProject } from '../onboarding/RepoSetup'
import { PublicAuthPage } from './PublicAuthPage'
import { SignIn } from './SignIn'
import { PanelHeading } from '../../ui/PageHeader'
import { AccountBar } from './AccountBar'
import { useSession } from './useSession'
import { SelectField, TextField } from '../../ui/fields'

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
/**
 * What each kind of request is, said as short lines: who should approve it,
 * what approving allows, and what else is worth knowing.
 */
const DECISION_COPY = {
  login: {
    only: 'you started velvet login on this device',
    allows: [
      'List and create organisations and projects.',
      'Create repository keys where you have write access.',
    ],
    notes: [
      'Routine work uses a separate key, limited to the project you choose.',
      'No repository is connected yet.',
    ],
  },
  init: {
    only: 'you started velvet init in this repository',
    allows: [],
    notes: [],
  },
  manage: {
    only: 'you started velvet admin login on this device',
    allows: [
      'Manage account settings and organisations, where your role allows it.',
      'Act across your whole account, not one project.',
    ],
    notes: [
      'It is a personal credential, limited by your current memberships and roles.',
      'It is separate from the setup access velvet login gives.',
      'Do not share it with repository agents.',
    ],
  },
  desktop: {
    only: 'you started sign-in in Velvet for macOS on your device',
    allows: [
      'Read your work.',
      'Create and update tickets.',
      'Manage settings, where your role allows it.',
    ],
    notes: [
      'It covers all your current and future organisations, limited by your current roles.',
      'It is not a repository or setup key. Do not share it with agents.',
      'You can revoke it under Profile > API tokens.',
    ],
  },
} as const

export function ApproveCLI() {
  const session = useSession()
  const [typed, setTyped] = useState(codeFromURL)
  const [code, setCode] = useState(codeFromURL)

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

  if (session.isLoading) return <PublicAuthPage title="Connect the Velvet CLI"><LoadingState className="">Loading…</LoadingState></PublicAuthPage>
  if (session.error) {
    return (
      <PublicAuthPage title="Connect the Velvet CLI">
        <div className="space-y-4">
          <ErrorNote title="Could not load your session">{session.error.message}</ErrorNote>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </PublicAuthPage>
    )
  }
  if (!session.isSignedIn) return <SignIn returnTo={code ? `/cli/approve?${new URLSearchParams({ code })}` : undefined} message="Sign in to review this device request. Signing in does not approve it." />

  const layout = (body: ReactNode, lead?: string, title?: string) => (
    <PublicAuthPage
      title={title ?? (desktop ? 'Connect Velvet for macOS' : 'Connect the Velvet CLI')}
      expanded
      lead={lead}
      account={<AccountBar user={session.user} />}
    >
      {/* Codes, choices and buttons read better in a column than across the whole card. */}
      <div className="max-w-[34rem] space-y-6">{body}</div>
    </PublicAuthPage>
  )

  // What each kind of request should do next, once it has been approved.
  const nextStep = desktop
    ? { where: 'Go back to Velvet for macOS.', what: 'The app is connected with your current memberships and roles.' }
    : manage
      ? { where: 'Go back to your terminal.', what: 'Account management is connected with your current memberships and roles.' }
      : login
        ? { where: 'Go back to your terminal.', what: 'Run this in your repository to choose its organisation and project:', command: 'velvet init' }
        : { where: 'Go back to your terminal.', what: `The CLI can now reach only ${projectKey} in ${slug}.` }

  if (approve.isSuccess) {
    // The outcome is the title, and the one thing left to do is set apart under it.
    return layout(
      <div role="status" className="space-y-6">
        <Card variant="muted" padding={5}>
          <Text as="p" type="supporting" color="secondary" display="block">Next</Text>
          <Text as="p" weight="semibold" display="block" className="mt-1">{nextStep.where}</Text>
          <Text as="p" color="secondary" display="block" className="mt-1 [overflow-wrap:anywhere]">{nextStep.what}</Text>
          {nextStep.command ? <p className="mt-3 font-mono text-ink" data-testid="cli-next-command">{nextStep.command}</p> : null}
        </Card>
        <Text as="p" type="supporting" color="secondary" display="block">You can close this page. To take the access back later, revoke it under Profile, in API tokens.</Text>
      </div>,
      undefined,
      'Connected',
    )
  }
  if (deny.isSuccess) {
    return layout(
      <div role="status" className="space-y-6">
        <Text as="p" display="block">{desktop ? 'The desktop app was not given a key.' : 'The CLI was not given a key.'} Nothing on your account changed.</Text>
        <Card variant="muted" padding={5}>
          <Text as="p" type="supporting" color="secondary" display="block">If you did start it</Text>
          <Text as="p" display="block" className="mt-1">
            {desktop ? 'Start sign-in again in Velvet for macOS to get a new code.' : 'Run the command again in your terminal to get a new code.'}
          </Text>
        </Card>
        <Text as="p" type="supporting" color="secondary" display="block">You can close this page.</Text>
      </div>,
      undefined,
      'Request refused',
    )
  }

  if (!code || pending.error) {
    const expired = pending.error instanceof ApiError && [404, 410].includes(pending.error.status)
    return layout(
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const next = typed.trim().toUpperCase(); if (next === code) void pending.refetch(); else setCode(next); approve.reset(); deny.reset() }}>
        {expired ? (
          <ErrorNote title="That code no longer works">
            It has expired or was already used. Run velvet login again to get a new one, or velvet init for an older repository request, then enter it here.
          </ErrorNote>
        ) : null}
        {pending.error && !expired ? (
          <ErrorNote title="Could not check that code">
            {pending.error.message} Check it matches your terminal and try again.
          </ErrorNote>
        ) : null}
        <TextField
          // A nine-character code does not need the whole column.
          className="max-w-[18rem] [&_input]:uppercase [&_input]:tracking-widest"
          label="Code shown on your device"
          size="lg"
          mono
          literal
          value={typed}
          onChange={setTyped}
          placeholder="ABCD-EFGH"
          autoComplete="off"
          required
        />
        <Button className="min-h-12" variant="primary" type="submit">Continue</Button>
      </form>,
      desktop ? 'Enter the code Velvet for macOS is showing to review its request.' : 'Enter the code your terminal is showing to review its request. Nothing is approved yet.',
    )
  }
  if (pending.isPending) return layout(<LoadingState className="">Checking the code…</LoadingState>)

  if (!unscoped && !legacyInit) {
    return layout(
      <ErrorNote title="This kind of request is not supported">
        Your CLI is asking for something this server does not recognise. Update the CLI, then run velvet login again.
      </ErrorNote>,
      undefined,
      'Request not recognised',
    )
  }

  if (!unscoped && writable.length === 0) {
    return layout(
      <ErrorNote title="You are a viewer in every organisation">
        A repository key can write, and viewers cannot. Ask an admin of the organisation for member access, then run the command again.
      </ErrorNote>,
      undefined,
      'No organisation to connect',
    )
  }

  const busy = approve.isPending || deny.isPending
  const ready = (unscoped || (slug !== '' && projectKey !== '' && !creating)) && !busy && !expired
  // Choosing where a repository key may reach. Only the older `velvet init` request asks for this.
  const chooser = (
    <>
      <SelectField
        label="Organisation"
        size="lg"
        value={slug}
        onChange={(value) => { setSlug(value); setProjectKey(''); setCreating(false) }}
        options={writable.map((m) => ({ value: m.workspace_slug, label: m.workspace_name }))}
      />

      <div className="space-y-1">
        <Text as="p" type="label" display="block">Project</Text>
        {projects.isPending ? <LoadingState className="">Loading projects…</LoadingState>
          : projects.error ? <ErrorNote>Could not load projects.</ErrorNote>
          : active.length === 0 || creating ? (
            <Card padding={5}>
            <div className="space-y-2">
              <Text as="p" color="secondary" display="block">{active.length === 0 ? 'This organisation has no active projects. Create one to connect.' : 'New project'}</Text>
              <NewProject
                slug={slug}
                onCancel={active.length > 0 ? () => setCreating(false) : undefined}
                onCreated={(p) => { setProjectKey(p.key); setCreating(false) }}
              />
            </div>
            </Card>
          )
          : (
            <>
              <SelectField
                label="Project"
                hideLabel
                size="lg"
                value={projectKey}
                onChange={setProjectKey}
                options={active.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` }))}
              />
              <div><Link onClick={() => setCreating(true)} hasUnderline>New project</Link></div>
            </>
          )}
        <Text as="p" type="supporting" color="secondary" display="block">The CLI, and any agent using it in this repository, can read and write only this project.</Text>
      </div>

    </>
  )
  const approveLabel = approve.isPending ? 'Connecting…' : desktop ? 'Approve desktop app' : manage ? 'Approve account management' : login ? 'Approve login' : 'Connect'

  const copy = DECISION_COPY[desktop ? 'desktop' : manage ? 'manage' : login ? 'login' : 'init']
  return layout(
    <div className="space-y-8">
      {/* 1. Is this the request you started? The code is the proof, so it is the largest thing here. */}
      <section aria-labelledby="cli-code-heading">
        <PanelHeading id="cli-code-heading">{desktop ? '1. Check the code in Velvet for macOS' : '1. Check the code in your terminal'}</PanelHeading>
        <Card variant="muted" padding={5}>
          <p className="break-all font-mono text-[2rem] leading-tight tracking-widest text-ink" data-testid="cli-user-code">{pending.data.user_code}</p>
          <Text as="p" type="supporting" color="secondary" display="block" className="mt-2 [overflow-wrap:anywhere]">Requested by {pending.data.client_name}</Text>
        </Card>
        <Text as="p" weight="semibold" display="block" className="mt-3">Approve only if {copy.only}.</Text>
      </section>

      {/* 2. What saying yes hands over, as a list instead of a paragraph. */}
      <section aria-labelledby="cli-allows-heading">
        <PanelHeading id="cli-allows-heading">{unscoped ? '2. What approving allows' : '2. Choose what it can reach'}</PanelHeading>
        {unscoped ? (
          <>
            <ul className="list-disc space-y-1 pl-5">
              {copy.allows.map((line) => <li key={line}>{line}</li>)}
            </ul>
            <ul className="mt-3 space-y-1">
              {copy.notes.map((line) => <li key={line}><Text type="supporting" color="secondary">{line}</Text></li>)}
            </ul>
          </>
        ) : (
          // A repository request is the choice itself: one organisation, one
          // project, and the line under them says that is all it can reach.
          <div className="space-y-4">{chooser}</div>
        )}
      </section>

      <div className="space-y-3">
        {deny.error ? <ErrorNote>{deny.error.message}</ErrorNote> : null}
        {expired ? (
          <ErrorNote title="This request expired">
            {desktop ? 'Start sign-in again in Velvet for macOS to get a new code.' : 'Run velvet login again to get a new code.'}
          </ErrorNote>
        ) : null}
        {approve.error ? <ErrorNote>{approve.error.message}</ErrorNote> : null}
        <form className="flex flex-wrap gap-3" aria-label={desktop ? 'Connect the desktop app' : 'Connect the CLI'} onSubmit={(e) => { e.preventDefault(); if (ready) approve.mutate() }}>
          <Button className="min-h-12 px-5" variant="primary" type="submit" disabled={!ready}>{approveLabel}</Button>
          <Button className="min-h-12" type="button" disabled={busy} onClick={() => deny.mutate()}>Refuse</Button>
        </form>
        <Text as="p" type="supporting" color="secondary" display="block">Refusing gives the device nothing. You can start again from it at any time.</Text>
      </div>
    </div>,
    desktop ? 'Velvet for macOS is asking to sign in as you. Check it is yours before approving.' : 'A terminal is asking for access to your account. Check it is yours before approving.',
  )
}
