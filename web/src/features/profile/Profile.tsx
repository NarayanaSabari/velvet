import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { ErrorNote } from '../../ui/ErrorNote'
import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Card } from '@astryxdesign/core/Card'
import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'

import { api } from '../../lib/api'
import { userLabel } from '../../lib/userLabel'
import { useSession } from '../auth/useSession'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { SectionNav } from '../../ui/SectionNav'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { RelativeTime } from '../../ui/RelativeTime'
import { onboardingQuery } from '../onboarding/onboardingQuery'
import { AgentConfig } from './AgentConfig'
import { GitHubAccountsTable } from './GitHubAccountsTable'
import { apiTokensQuery, type CreatedApiToken } from './apiTokens'
import { PROFILE_PAGES, type ProfilePageId } from './profilePages'
import { TextField } from '../../ui/fields'

export function ProfileRoute() {
  const { slug, page } = useParams({ from: '/w/$slug/settings/profile/$page' })
  // Workspace changes reset private state. Section changes reset only content,
  // keeping the section navigation mounted so keyboard focus stays predictable.
  return <Profile key={slug} slug={slug} page={page as ProfilePageId} />
}

export function Profile({ slug, page = 'general' }: { slug: string; page?: ProfilePageId }) {
  const session = useSession(slug)
  if (session.isLoading) return <LoadingState label="Loading profile…" />
  if (!session.user) return null
  const current = PROFILE_PAGES.find((candidate) => candidate.id === page)!
  return <div className="w-full min-w-0">
    <PageHeader eyebrow="Profile" title={current.label} description={current.description} />
    <div className="grid gap-4 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
      <div className="min-w-0">
        <SectionNav
          label="Profile sections"
          current={page}
          items={PROFILE_PAGES.map((section) => ({
            id: section.id,
            label: section.label,
            href: `/w/${slug}/settings/profile/${section.id}`,
          }))}
        />
      </div>
      <div key={page} className="min-w-0">
        {page === 'general' ? <section className="space-y-3" aria-labelledby="identity-heading">
          <SectionHeader id="identity-heading" title="Identity" />
          <div className="flex items-center gap-3">
            <Avatar user={session.user} size="lg" />
            <div className="min-w-0">
              <Text as="p" weight="semibold" display="block" className="break-words">{userLabel(session.user)}</Text>
              {session.user.email && session.user.email !== userLabel(session.user) ? <Text as="p" type="supporting" color="secondary" display="block" className="break-all">{session.user.email}</Text> : null}
            </div>
          </div>
          <Text as="p" color="secondary" display="block" className="max-w-[46rem]">Your identity and personal API tokens are shared across your organisations. Agent setup uses the current organisation.</Text>
        </section> : null}
        {page === 'github' ? <GitHubProfile slug={slug} /> : null}
        {page === 'agent-config' && session.workspace ? <AgentConfig workspace={session.workspace} /> : null}
        {page === 'tokens' ? <ApiTokens /> : null}
      </div>
    </div>
  </div>
}

export function GitHubProfile({ slug }: { slug: string }) {
  const session = useSession(slug)
  if (session.isLoading) return <LoadingState label="Loading profile…" />
  if (!session.user) return null
  return <GitHubAccountsTable key={session.user.id} memberships={session.memberships} currentSlug={slug} globalAccount={session.user} />
}

function TokenForm({
  name,
  onChange,
  onSubmit,
  isPending,
}: {
  name: string
  onChange: (name: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  isPending: boolean
}) {
  return (
    <form className="flex max-w-2xl flex-col gap-2 sm:flex-row sm:items-end" onSubmit={onSubmit}>
      <TextField
        className="flex-1"
        label="Token name"
        name="name"
        autoComplete="off"
        required
        value={name}
        onChange={onChange}
      />
      <Button className="self-start sm:self-auto" variant="primary" type="submit" disabled={isPending || !name.trim()}>
        {isPending ? 'Creating…' : 'Create token'}
      </Button>
    </form>
  )
}

export function ApiTokens() {
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [createdToken, setCreatedToken] = useState<CreatedApiToken | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const tokens = useQuery(apiTokensQuery)
  const create = useMutation({
    mutationFn: () => api.post<CreatedApiToken>('/me/tokens', { name: name.trim() }),
    onSuccess: async (token) => {
      setName('')
      setCreatedToken(token)
      setCopied(false)
      setCopyError(null)
      await client.invalidateQueries({ queryKey: apiTokensQuery.queryKey })
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/me/tokens/${id}`),
    onSuccess: async () => {
      setConfirmingId(null)
      await client.invalidateQueries({ queryKey: apiTokensQuery.queryKey })
      // Revoking the last used key means no agent is connected any more.
      await client.invalidateQueries({ queryKey: onboardingQuery.queryKey })
    },
  })

  const form = (
    <TokenForm
      name={name}
      onChange={setName}
      onSubmit={(event) => {
        event.preventDefault()
        revoke.reset()
        create.mutate()
      }}
      isPending={create.isPending}
    />
  )

  async function copyToken() {
    if (!createdToken) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(createdToken.token)
      } else {
        const input = document.createElement('textarea')
        input.value = createdToken.token
        input.setAttribute('readonly', '')
        input.style.position = 'fixed'
        input.style.left = '-9999px'
        document.body.appendChild(input)
        input.select()
        const copied = document.execCommand('copy')
        input.remove()
        if (!copied) throw new Error('clipboard unavailable')
      }
      setCopied(true)
      setCopyError(null)
    } catch {
      setCopyError('Could not copy the token. Select it and copy it manually.')
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="api-tokens-heading">
      <SectionHeader id="api-tokens-heading" title="API tokens" />
      <p className="text-grey-500">Create a personal token for tools that need to write to your worklog.</p>

      {createdToken ? (
        <div role="status" aria-live="polite">
        <Card variant="muted" padding={5}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">Token created</p>
              <p className="text-sm text-grey-700">Copy it now. This token will not be shown again.</p>
            </div>
            <Button onClick={() => setCreatedToken(null)}>Dismiss token</Button>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
            <code className="ui-control min-w-0 flex-1 break-all px-2 py-1 font-mono text-sm">
              {createdToken.token}
            </code>
            <Button aria-label="Copy API token" onClick={() => void copyToken()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {copyError ? <ErrorNote className="mt-2">{copyError}</ErrorNote> : null}
        </Card>
        </div>
      ) : null}

      {create.error ? <ErrorNote>{create.error.message}</ErrorNote> : null}
      {tokens.error ? (
        <ErrorState
          message="Could not load API tokens."
          onRetry={() => void tokens.refetch()}
          retrying={tokens.isRefetching}
        />
      ) : null}
      {revoke.error ? <ErrorNote>{revoke.error.message}</ErrorNote> : null}
      {tokens.isPending ? <LoadingState label="Loading API tokens…" /> : null}

      {tokens.data?.tokens.length === 0 ? (
        <EmptyState
          title="No API tokens yet"
          message="Let a CLI or coding agent write to your worklog."
          action={form}
        />
      ) : null}

      {tokens.data && tokens.data.tokens.length > 0 ? (
        <>
          {form}
          <div className="border-y border-grey-200">
          <List hasDividers density="balanced" edge="flush" aria-label="API tokens">
            {tokens.data.tokens.map((token) => (
              <ListItem key={token.id} itemKey={token.id} label={(
              <div className="flex flex-wrap items-center gap-3 py-1">
                <div className="min-w-0 flex-1">
                  <Text as="p" weight="medium" display="block" className="break-all">{token.name}</Text>
                  <p className="break-words text-xs text-grey-700">
                    {token.kind === 'desktop' ? 'Desktop app · All organisations, current roles' : token.kind === 'setup' ? 'Machine setup key' : token.project_key ? <>{token.parent_id ? 'Derived project key' : 'Project key'} · {token.workspace_slug} / {token.project_key}</> : 'Personal token'}
                  </p>
                  <dl className="flex flex-wrap gap-x-4 text-xs text-grey-500">
                    <div>
                      <dt className="sr-only">Created</dt>
                      <dd>Created <RelativeTime iso={token.created_at} /></dd>
                    </div>
                    <div>
                      <dt className="sr-only">Last used</dt>
                      <dd>Last used {token.last_used_at ? <RelativeTime iso={token.last_used_at} /> : 'Never used'}</dd>
                    </div>
                  </dl>
                </div>
                <Button
                  variant="danger"
                  aria-label={`Revoke ${token.name}`}
                  disabled={revoke.isPending || create.isPending}
                  onClick={() => {
                    create.reset()
                    revoke.reset()
                    setConfirmingId(token.id)
                  }}
                >
                  Revoke
                </Button>
                <ConfirmDialog
                  open={confirmingId === token.id}
                  onClose={() => { revoke.reset(); setConfirmingId(null) }}
                  title={`Revoke ${token.name}?`}
                  description={token.kind === 'setup'
                    ? 'This revokes the machine setup key and all project keys derived from it. Every repository using those keys will stop working.'
                    : 'Any clients using it will stop working.'}
                  actionLabel="Confirm revoke"
                  pending={revoke.isPending}
                  error={revoke.error ? `${revoke.error.message} Try again, or cancel.` : null}
                  onConfirm={() => revoke.mutate(token.id)}
                />
              </div>
              )} />
            ))}
          </List>
          </div>
        </>
      ) : null}

      <p className="text-sm text-grey-500">Use a token with the <code className="font-mono">Authorization: Bearer &lt;token&gt;</code> header.</p>
    </section>
  )
}
