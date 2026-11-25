import { LoadingState } from '../../ui/QueryState'
import { ErrorNote } from '../../ui/ErrorNote'
import { useId, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Card } from '@astryxdesign/core/Card'
import { Heading } from '../../ui/Heading'
import { Link } from '@astryxdesign/core/Link'
import { List, ListItem } from '@astryxdesign/core/List'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { Step, Stepper } from '@astryxdesign/core/Stepper'
import { Text } from '@astryxdesign/core/Text'

import { api, ApiError } from '../../lib/api'
import type { Invitation, Membership } from '../../lib/types'
import { Button } from '../../ui/Button'
import { AccountBar } from '../auth/AccountBar'
import { PublicAuthPage } from '../auth/PublicAuthPage'
import { SignIn } from '../auth/SignIn'
import { navigateTo } from '../auth/sessionNavigation'
import { useSession } from '../auth/useSession'
import { LinkedRepositories } from './AgentSetup'
import { onboardingQuery, type OnboardingPayload } from './onboardingQuery'
import { RepoSetup } from './RepoSetup'
import { TextField } from '../../ui/fields'

const STEPS = ['Organisation', 'Connect agent'] as const

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
  const workspace = created ?? session.memberships[0] ?? null

  const layout = (children: ReactNode) => (
    <PublicAuthPage
      title="Set up Velvet"
      expanded
      lead="Two steps to let your coding agent keep your work log."
      account={session.isSignedIn ? <AccountBar user={session.user} /> : undefined}
    >
      <div className="space-y-6">{children}</div>
    </PublicAuthPage>
  )

  if (session.isLoading) return layout(<LoadingState className="">Loading…</LoadingState>)
  if (!session.isSignedIn) return <SignIn />
  if (onboarding.isPending) return layout(<LoadingState className="">Loading…</LoadingState>)
  if (onboarding.error || !onboarding.data) {
    return layout(<div className="space-y-3">
      <ErrorNote>Could not load your setup. Try again.</ErrorNote>
      <Button className="min-h-12" onClick={() => void onboarding.refetch()}>Try again</Button>
    </div>)
  }

  const { suggestion, base_url: baseUrl } = onboarding.data
  const step = !workspace ? 0 : 1

  return layout(<>

    <div data-testid="onboarding-steps">
      <Stepper activeStep={step} label="Setup progress">
        {STEPS.map((label, index) => (
          <Step key={label} step={index} label={label} indicator="number" />
        ))}
      </Stepper>
    </div>

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

    {step === 1 && workspace ? <ConnectStep baseUrl={baseUrl} workspace={workspace} /> : null}

    {workspace ? (
      <div className="border-t border-grey-200 pt-4 text-sm">
        <Link href={`/w/${workspace.workspace_slug}`} hasUnderline>Go to your dashboard</Link>
        <Text as="p" type="supporting" color="secondary" display="block" className="mt-2">You can connect more repositories later from Profile, under Agent config.</Text>
      </div>
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
        <Heading level={3} accessibilityLevel={2} id={`${nameId}-heading`}>Create your organisation</Heading>
        <Text as="p" color="secondary" display="block" className="mt-1">
          Your tickets and work log live here. It starts with your name, and you can rename it any time.
        </Text>
      </div>

      {pending.length > 0 ? (
        <Card padding={5}>
          <Heading level={4} accessibilityLevel={3}>You have been invited</Heading>
          <div className="mt-2">
            <List hasDividers density="balanced" edge="flush" aria-label="Invitations">
              {pending.map((invite) => (
                <ListItem
                  key={invite.id}
                  itemKey={invite.id}
                  label={(
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {invite.workspace_name} <Text color="secondary">({invite.role})</Text>
                    </span>
                  )}
                  endContent={(
                    <Button
                      className="shrink-0"
                      disabled={accept.isPending}
                      aria-label={`Accept ${invite.workspace_name} invitation`}
                      onClick={() => accept.mutate(invite.id)}
                    >
                      {accept.isPending && accept.variables === invite.id ? 'Accepting…' : 'Accept'}
                    </Button>
                  )}
                />
              ))}
            </List>
          </div>
          {accept.error ? <ErrorNote className="mt-2">{accept.error.message}</ErrorNote> : null}
          <Text as="p" type="supporting" color="secondary" display="block" className="mt-3">Or create your own organisation below.</Text>
        </Card>
      ) : null}

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!create.isPending) create.mutate()
        }}
      >
        {!editing ? (
          <div data-testid="onboarding-org-preview">
          <Card padding={5}>
            <Text as="p" type="large" weight="semibold" display="block" className="[overflow-wrap:anywhere]">{suggestion.name}</Text>
            <div className="mt-3">
              <MetadataList label={{ position: 'start', width: '6rem' }}>
                <MetadataListItem label="Address">
                  <Text type="code" className="[overflow-wrap:anywhere]">/w/{suggestion.slug}</Text>
                </MetadataListItem>
                <MetadataListItem label="Ticket keys">
                  <Text type="code">{suggestion.issue_prefix}-1, {suggestion.issue_prefix}-2…</Text>
                </MetadataListItem>
              </MetadataList>
            </div>
            <div className="mt-3 -ml-2">
              <Button variant="ghost" onClick={() => setEditing(true)}>Change these</Button>
            </div>
          </Card>
          </div>
        ) : (
          <div className="space-y-4">
            <TextField label="Organisation name" size="lg" required maxLength={80} value={name} onChange={setName} />
            <TextField
              label="Address"
              description="3 to 40 lowercase letters, digits or hyphens."
              size="lg"
              mono
              required
              minLength={3}
              maxLength={40}
              pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
              value={slug}
              onChange={(value) => setSlug(value.toLowerCase())}
            />
            <TextField
              label="Ticket prefix"
              description={`2 to 6 letters, used in ticket keys such as ${prefix || 'ABC'}-1.`}
              size="lg"
              mono
              required
              minLength={2}
              maxLength={6}
              pattern="[A-Z]{2,6}"
              value={prefix}
              onChange={(value) => setPrefix(value.toUpperCase())}
            />
          </div>
        )}

        <Button className="min-h-12 px-4" variant="primary" type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create organisation'}
        </Button>
        {create.error ? <ErrorNote>{create.error.message}</ErrorNote> : null}
      </form>
    </section>
  )
}

function ConnectStep({ baseUrl, workspace }: { baseUrl: string; workspace: Membership }) {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <div>
        <Heading level={3} accessibilityLevel={2} id={headingId}>Connect your coding agent</Heading>
        <p className="mt-1 text-grey-500 [overflow-wrap:anywhere]">
          <span className="font-medium text-ink">{workspace.workspace_name}</span> is ready. Link a repository and your
          agent logs work from it with the <code>velvet</code> command. Each repository is linked to one project, and
          its key stays on your machine, is never shown here, and can reach only that project.
        </p>
      </div>
      {/* The connection status comes first, so progress shows without
          scrolling past the steps to find it. */}
      <LinkedRepositories slug={workspace.workspace_slug} workspaceName={workspace.workspace_name} />
      {/* This step's own heading already says what it is, so the setup does not repeat it. */}
      <RepoSetup workspace={workspace} baseUrl={baseUrl} hasHeading={false} />
    </section>
  )
}
