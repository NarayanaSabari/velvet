import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { api, ApiError } from '../../lib/api'
import type { Invitation, Membership } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Button } from '../../ui/Button'
import { buttonClassName } from '../../ui/buttonStyles'
import { PublicAuthPage } from '../auth/PublicAuthPage'
import { SignIn } from '../auth/SignIn'
import { SignOutButton } from '../auth/SignOutButton'
import { navigateTo } from '../auth/sessionNavigation'
import { useSession } from '../auth/useSession'
import { agentSnippets, mcpUrl, type AgentId } from './agentSnippets'
import { onboardingQuery, type OnboardingPayload } from './onboardingQuery'

interface CreatedToken {
  id: string
  name: string
  token: string
}

const TOKEN_NAME = 'Coding agent'
const STEPS = ['Organisation', 'API key', 'Connect agent'] as const
const inputClass = 'mt-1 block min-h-12 w-full rounded-[var(--radius-control)] border border-grey-300 bg-paper px-3 py-2'

/**
 * Takes a newly signed-in person from nothing to an agent that writes to their
 * work log: an organisation named after them, one API key shown once, and a
 * ready-to-paste config for their agent. Progress lives on the server, so a
 * refresh or a return visit resumes at the right step.
 */
export function Onboarding({ navigate = navigateTo }: { navigate?: (to: string) => void }) {
  const session = useSession()
  const client = useQueryClient()
  const onboarding = useQuery({ ...onboardingQuery, enabled: session.isSignedIn })
  // The organisation the agent will write to: the one just created, or the
  // person's first when they return after creating it.
  const [created, setCreated] = useState<Membership | null>(null)
  const [token, setToken] = useState<CreatedToken | null>(null)
  const workspace = created ?? session.memberships[0] ?? null

  const layout = (children: ReactNode) => (
    <PublicAuthPage title="Set up Velvet" note="" expanded>
      <div className="space-y-6">{children}</div>
    </PublicAuthPage>
  )

  if (session.isLoading) return layout(<p role="status" className="text-grey-500">Loading…</p>)
  if (!session.isSignedIn) return <SignIn />
  if (onboarding.isPending) return layout(<p role="status" className="text-grey-500">Loading…</p>)
  if (onboarding.error || !onboarding.data) {
    return layout(<div className="space-y-3">
      <p role="alert" className="text-blocked">Could not load your setup. Try again.</p>
      <Button className="min-h-12" onClick={() => void onboarding.refetch()}>Try again</Button>
    </div>)
  }

  const { state, suggestion, base_url: baseUrl } = onboarding.data
  const step = !workspace ? 0 : !token ? 1 : 2

  return layout(<>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-grey-700 [overflow-wrap:anywhere]">Signed in as {userLabel(session.user)}</p>
        <p className="mt-1 text-sm text-grey-500">Three steps to let your coding agent keep your work log.</p>
      </div>
      <SignOutButton publicStyle />
    </header>

    <ol aria-label="Setup progress" className="grid grid-cols-3 gap-2" data-testid="onboarding-steps">
      {STEPS.map((label, index) => (
        <li
          key={label}
          aria-current={index === step ? 'step' : undefined}
          className={`border-t-2 pt-2 text-xs ${index < step ? 'border-ink text-grey-700' : index === step ? 'border-ink font-medium text-ink' : 'border-grey-200 text-grey-500'}`}
        >
          <span className="sr-only">{index < step ? 'Completed: ' : index === step ? 'Current: ' : 'Upcoming: '}</span>
          {index + 1}. {label}
        </li>
      ))}
    </ol>

    {step === 0 ? (
      <OrganisationStep
        suggestion={suggestion}
        onCreated={async (membership) => {
          setCreated(membership)
          await client.invalidateQueries({ queryKey: ['session'] })
          await client.invalidateQueries({ queryKey: onboardingQuery.queryKey })
        }}
        onAccepted={(membership) => navigate(`/w/${membership.workspace_slug}`)}
      />
    ) : null}

    {step === 1 && workspace ? (
      <TokenStep
        workspace={workspace}
        hasToken={state.has_token}
        onCreated={setToken}
      />
    ) : null}

    {step === 2 && workspace && token ? (
      <ConnectStep baseUrl={baseUrl} workspace={workspace} token={token.token} />
    ) : null}

    {workspace ? (
      <p className="border-t border-grey-200 pt-4 text-sm">
        <NavLink to={`/w/${workspace.workspace_slug}`} className="underline underline-offset-4">
          {step === 2 ? 'Go to your dashboard' : 'Skip for now and go to your dashboard'}
        </NavLink>
      </p>
    ) : null}
  </>)
}

function OrganisationStep({
  suggestion,
  onCreated,
  onAccepted,
}: {
  suggestion: OnboardingPayload['suggestion']
  onCreated: (membership: Membership) => void | Promise<void>
  onAccepted: (membership: Membership) => void
}) {
  const nameId = useId()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(suggestion.name)
  const [slug, setSlug] = useState(suggestion.slug)
  const [prefix, setPrefix] = useState(suggestion.issue_prefix)
  const invites = useQuery({
    queryKey: ['my-invites'],
    queryFn: () => api.get<{ invites: Invitation[] }>('/me/invites'),
  })
  const create = useMutation({
    mutationFn: () => api.post<Membership>('/me/onboarding/organisation', editing
      ? { name: name.trim(), slug: slug.trim(), issue_prefix: prefix.trim() }
      : {}),
    onSuccess: onCreated,
  })
  const accept = useMutation({
    mutationFn: (id: string) => api.post<Membership>(`/me/invites/${id}/accept`),
    onSuccess: onAccepted,
    onError: (error) => { if (error instanceof ApiError && error.status === 410) navigateTo('/expired') },
  })
  const pending = invites.data?.invites ?? []

  return (
    <section aria-labelledby={`${nameId}-heading`} className="space-y-4">
      <div>
        <h2 id={`${nameId}-heading`} className="text-base font-medium">Create your organisation</h2>
        <p className="mt-1 text-sm text-grey-700">
          Your tickets and work log live here. It starts with your name, and you can rename it any time.
        </p>
      </div>

      {pending.length > 0 ? (
        <div className="rounded-[var(--radius-surface)] border border-grey-200 p-4">
          <h3 className="text-sm font-medium">You have been invited</h3>
          <ul className="mt-3 space-y-2">
            {pending.map((invite) => (
              <li key={invite.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {invite.workspace_name} <span className="text-grey-500">({invite.role})</span>
                </span>
                <Button
                  className="min-h-12 shrink-0"
                  disabled={accept.isPending}
                  aria-label={`Accept ${invite.workspace_name} invitation`}
                  onClick={() => accept.mutate(invite.id)}
                >
                  {accept.isPending && accept.variables === invite.id ? 'Accepting…' : 'Accept'}
                </Button>
              </li>
            ))}
          </ul>
          {accept.error ? <p role="alert" className="mt-2 text-sm text-blocked">{accept.error.message}</p> : null}
          <p className="mt-3 text-xs text-grey-500">Or create your own organisation below.</p>
        </div>
      ) : null}

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!create.isPending) create.mutate()
        }}
      >
        {!editing ? (
          <div className="rounded-[var(--radius-surface)] border border-grey-200 p-4" data-testid="onboarding-org-preview">
            <p className="text-lg font-medium [overflow-wrap:anywhere]">{suggestion.name}</p>
            <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-grey-500">Address</dt>
              <dd className="min-w-0 font-mono text-grey-700 [overflow-wrap:anywhere]">/w/{suggestion.slug}</dd>
              <dt className="text-grey-500">Ticket keys</dt>
              <dd className="font-mono text-grey-700">{suggestion.issue_prefix}-1, {suggestion.issue_prefix}-2…</dd>
            </dl>
            <Button variant="ghost" className="-ml-2.5 mt-2 min-h-11 underline" onClick={() => setEditing(true)}>
              Change these
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block text-sm">Organisation name
              <input className={inputClass} required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="block text-sm">Address
              <input
                className={`${inputClass} font-mono`}
                required
                minLength={3}
                maxLength={40}
                pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
                value={slug}
                aria-describedby={`${nameId}-slug-help`}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
              />
            </label>
            <p id={`${nameId}-slug-help`} className="text-xs text-grey-500">3 to 40 lowercase letters, digits or hyphens.</p>
            <label className="block text-sm">Ticket prefix
              <input
                className={`${inputClass} font-mono`}
                required
                minLength={2}
                maxLength={6}
                pattern="[A-Z]{2,6}"
                value={prefix}
                aria-describedby={`${nameId}-prefix-help`}
                onChange={(event) => setPrefix(event.target.value.toUpperCase())}
              />
            </label>
            <p id={`${nameId}-prefix-help`} className="text-xs text-grey-500">2 to 6 letters, used in ticket keys such as {prefix || 'ABC'}-1.</p>
          </div>
        )}

        <Button className="min-h-12 px-4" variant="primary" type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create organisation'}
        </Button>
        {create.error ? <p role="alert" className="text-sm text-blocked">{create.error.message}</p> : null}
      </form>
    </section>
  )
}

function TokenStep({
  workspace,
  hasToken,
  onCreated,
}: {
  workspace: Membership
  hasToken: boolean
  onCreated: (token: CreatedToken) => void
}) {
  const headingId = useId()
  const create = useMutation({
    mutationFn: () => api.post<CreatedToken>('/me/tokens', { name: `${TOKEN_NAME} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}` }),
    onSuccess: onCreated,
  })

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h2 id={headingId} className="text-base font-medium">Create an API key for your agent</h2>
        <p className="mt-1 text-sm text-grey-700 [overflow-wrap:anywhere]">
          <span className="font-medium text-ink">{workspace.workspace_name}</span> is ready. Your agent signs in to
          Velvet with a personal API key. It can do what you can, and nothing else.
        </p>
        {hasToken ? (
          <p className="mt-2 text-sm text-grey-500">
            You already have a key, but it is only shown when it is created, so make a new one for this setup.
          </p>
        ) : null}
      </div>
      <Button className="min-h-12 px-4" variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
        {create.isPending ? 'Creating key…' : 'Create API key'}
      </Button>
      {create.error ? <p role="alert" className="text-sm text-blocked">{create.error.message}</p> : null}
    </section>
  )
}

function ConnectStep({ baseUrl, workspace, token }: { baseUrl: string; workspace: Membership; token: string }) {
  const headingId = useId()
  const tabsId = useId()
  const snippets = agentSnippets(baseUrl, workspace.workspace_slug, token)
  const [agent, setAgent] = useState<AgentId>('claude')
  const current = snippets.find((snippet) => snippet.id === agent) ?? snippets[0]!
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  // The first agent call marks a token as used; watching for it confirms the
  // setup worked without asking the person to come back and check.
  const status = useQuery({
    ...onboardingQuery,
    refetchInterval: (query) => (query.state.data?.state.agent_connected ? false : 3000),
  })
  const connected = status.data?.state.agent_connected ?? false

  const moveTab = (offset: number) => {
    const index = snippets.findIndex((snippet) => snippet.id === agent)
    const next = snippets[(index + offset + snippets.length) % snippets.length]!
    setAgent(next.id)
    tabRefs.current[next.id]?.focus()
  }

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <div>
        <h2 id={headingId} className="text-base font-medium">Connect your coding agent</h2>
        <p className="mt-1 text-sm text-grey-700">
          Copy your key now. It will not be shown again, but you can always create another in your profile.
        </p>
      </div>

      <CopyField label="Your API key" value={token} testId="onboarding-token" />
      <CopyField label="MCP server URL" value={mcpUrl(baseUrl, workspace.workspace_slug)} testId="onboarding-mcp-url" />

      <div>
        <div role="tablist" aria-label="Choose your agent" className="flex flex-wrap gap-1 border-b border-grey-200">
          {snippets.map((snippet) => (
            <button
              key={snippet.id}
              ref={(element) => { tabRefs.current[snippet.id] = element }}
              type="button"
              role="tab"
              id={`${tabsId}-${snippet.id}`}
              aria-selected={snippet.id === agent}
              aria-controls={`${tabsId}-panel`}
              tabIndex={snippet.id === agent ? 0 : -1}
              onClick={() => setAgent(snippet.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') { event.preventDefault(); moveTab(1) }
                if (event.key === 'ArrowLeft') { event.preventDefault(); moveTab(-1) }
              }}
              className={`-mb-px min-h-11 border-b-2 px-3 text-sm ${snippet.id === agent ? 'border-ink font-medium text-ink' : 'border-transparent text-grey-700 hover:text-ink'}`}
            >
              {snippet.label}
            </button>
          ))}
        </div>
        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${current.id}`} className="space-y-3 pt-4">
          <p className="text-sm text-grey-700">{current.where}</p>
          <CopyField label={`${current.label} setup`} value={current.code} multiline testId="onboarding-snippet" />
          {current.after ? <p className="text-xs text-grey-500 [overflow-wrap:anywhere]">{current.after}</p> : null}
        </div>
      </div>

      <div
        role="status"
        aria-live="polite"
        data-testid="onboarding-connection"
        data-connected={connected ? 'true' : 'false'}
        className={`flex items-start gap-3 rounded-[var(--radius-surface)] border p-4 text-sm ${connected ? 'border-done' : 'border-grey-200'}`}
      >
        <span
          aria-hidden="true"
          className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${connected ? 'bg-done' : 'animate-pulse bg-grey-500 motion-reduce:animate-none'}`}
        />
        {connected ? (
          <div>
            <p className="font-medium">Your agent is connected.</p>
            <p className="mt-1 text-grey-700">
              Ask it to log what it just did, and the entry appears in {workspace.workspace_name}.
            </p>
          </div>
        ) : (
          <div>
            <p className="font-medium">Waiting for your agent…</p>
            <p className="mt-1 text-grey-700">
              After pasting the setup, start your agent and ask it: “Which Velvet organisation are you connected to?”
            </p>
          </div>
        )}
      </div>

      {connected ? (
        <NavLink to={`/w/${workspace.workspace_slug}`} className={buttonClassName('primary', 'inline-flex min-h-12 items-center px-4 no-underline')}>
          Go to your dashboard
        </NavLink>
      ) : null}
    </section>
  )
}

function CopyField({ label, value, multiline = false, testId }: { label: string; value: string; multiline?: boolean; testId: string }) {
  const labelId = useId()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span id={labelId} className="text-xs text-grey-500">{label}</span>
        <Button className="min-h-11 shrink-0" aria-label={`Copy ${label}`} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        aria-labelledby={labelId}
        data-testid={testId}
        tabIndex={0}
        className={`mt-1 overflow-x-auto rounded-[var(--radius-control)] border border-grey-200 bg-grey-100 p-3 font-mono text-xs text-ink ${multiline ? 'whitespace-pre-wrap break-all' : 'whitespace-pre-wrap [overflow-wrap:anywhere]'}`}
      >
        {value}
      </pre>
      {failed ? <p role="alert" className="mt-1 text-xs text-blocked">Could not copy. Select the text and copy it manually.</p> : null}
    </div>
  )
}
