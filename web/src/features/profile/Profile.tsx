import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { api } from '../../lib/api'
import { userLabel } from '../../lib/userLabel'
import { useSession } from '../auth/useSession'
import { clearPrivateQueries, refreshPrivateQueries, navigateTo } from '../auth/sessionNavigation'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { RelativeTime } from '../../ui/RelativeTime'

interface ApiToken {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
}

interface CreatedApiToken {
  id: string
  name: string
  token: string
}

export function ProfileRoute() {
  const { slug } = useParams({ from: '/w/$slug/settings/profile' })
  return <Profile slug={slug} />
}

export function Profile({ slug }: { slug: string }) {
  const session = useSession(slug)
  const client = useQueryClient()
  const unlink = useMutation({
    mutationFn: () => api.del('/me/github'),
    onSuccess: () => refreshPrivateQueries(client),
  })
  if (session.isLoading) return <LoadingState label="Loading profile…" />
  if (!session.user) return null
  return <div className="max-w-lg space-y-4">
    <h1 className="text-lg">Profile</h1>
    <p>{userLabel(session.user)}</p>
    {session.user.email && session.user.email !== userLabel(session.user) ? <p className="text-grey-500">{session.user.email}</p> : null}
    <h2 className="border-b border-grey-200 pb-1 text-base">GitHub profile</h2>
    <p className="text-grey-500">Link your GitHub identity to attribute your work. Organisation installation ownership is verified separately in Administration.</p>
    {session.user.github_login ? <>
      <p>Linked to @{session.user.github_login}</p>
      <Button disabled={unlink.isPending} onClick={() => unlink.mutate()}>Unlink GitHub profile</Button>
    </> : <a className="underline" href="/api/v1/auth/github/link" onClick={async (event) => {
      event.preventDefault()
      await clearPrivateQueries(client)
      navigateTo('/api/v1/auth/github/link')
    }}>Link GitHub profile</a>}
    {unlink.error ? <p role="alert" className="text-blocked">{unlink.error.message}</p> : null}
    <ApiTokens />
  </div>
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
    <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={onSubmit}>
      <label className="min-w-0 flex-1">
        <span className="mb-0.5 block text-xs text-grey-500">Token name</span>
        <input
          className="block w-full border border-grey-300 bg-paper px-2 py-1"
          type="text"
          name="name"
          autoComplete="off"
          required
          value={name}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
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
  const tokens = useQuery({
    queryKey: ['api-tokens'],
    queryFn: () => api.get<{ tokens: ApiToken[] }>('/me/tokens'),
  })
  const create = useMutation({
    mutationFn: () => api.post<CreatedApiToken>('/me/tokens', { name: name.trim() }),
    onSuccess: async (token) => {
      setName('')
      setCreatedToken(token)
      setCopied(false)
      setCopyError(null)
      await client.invalidateQueries({ queryKey: ['api-tokens'] })
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/me/tokens/${id}`),
    onSuccess: async () => {
      setConfirmingId(null)
      await client.invalidateQueries({ queryKey: ['api-tokens'] })
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
    <section className="mt-8 space-y-3" aria-labelledby="api-tokens-heading">
      <h2 id="api-tokens-heading" className="border-b border-grey-200 pb-1 text-base">API tokens</h2>
      <p className="text-grey-500">Create a personal token for tools that need to write to your worklog.</p>

      {createdToken ? (
        <div className="border border-grey-300 bg-grey-100 p-3" role="status" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">Token created</p>
              <p className="text-sm text-grey-700">Copy it now. This token will not be shown again.</p>
            </div>
            <Button onClick={() => setCreatedToken(null)}>Dismiss token</Button>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
            <code className="min-w-0 flex-1 break-all border border-grey-300 bg-paper px-2 py-1 font-mono text-sm">
              {createdToken.token}
            </code>
            <Button aria-label="Copy API token" onClick={() => void copyToken()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {copyError ? <p role="alert" className="mt-2 text-sm text-blocked">{copyError}</p> : null}
        </div>
      ) : null}

      {create.error ? <p role="alert" className="text-blocked">{create.error.message}</p> : null}
      {tokens.error ? (
        <ErrorState
          message="Could not load API tokens."
          onRetry={() => void tokens.refetch()}
          retrying={tokens.isRefetching}
        />
      ) : null}
      {revoke.error ? <p role="alert" className="text-blocked">{revoke.error.message}</p> : null}
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
          <ul className="divide-y divide-grey-200 border-y border-grey-200">
            {tokens.data.tokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-3 px-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="break-all">{token.name}</p>
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
                {confirmingId === token.id ? (
                  <div className="basis-full border border-grey-200 bg-grey-100 p-2" role="group" aria-label={`Confirm revocation of ${token.name}`}>
                    <p className="text-sm">Revoke {token.name}? Any clients using it will stop working.</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(token.id)}>
                        {revoke.isPending ? 'Revoking…' : 'Confirm revoke'}
                      </Button>
                      <Button disabled={revoke.isPending} onClick={() => setConfirmingId(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="text-sm text-grey-500">Use a token with the <code className="font-mono">Authorization: Bearer &lt;token&gt;</code> header.</p>
    </section>
  )
}
