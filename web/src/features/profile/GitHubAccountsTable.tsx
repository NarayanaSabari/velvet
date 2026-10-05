import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Membership, User } from '../../lib/types'
import { clearPrivateQueries, navigateTo, refreshPrivateQueries } from '../auth/sessionNavigation'
import { Button } from '../../ui/Button'
import { buttonClassName } from '../../ui/buttonStyles'
import { SectionHeader } from '../../ui/PageHeader'
import { organisationGitHubQuery } from './organisationGitHub'

type GitHubAccount = Pick<User, 'github_id' | 'github_login'>

export function GitHubAccountsTable({ memberships, currentSlug, globalAccount }: {
  memberships: Membership[]
  currentSlug: string
  globalAccount?: GitHubAccount
}) {
  return <section className="space-y-3" aria-labelledby="github-accounts-heading">
    <SectionHeader id="github-accounts-heading" title="GitHub accounts by organisation" />
    <p className="max-w-[46rem] text-grey-500">Link or change the account used for your work in each organisation. GitHub is optional.</p>
    {memberships.length === 0 && !globalAccount ? <p className="text-grey-500">No organisations to show.</p> : <div className="rounded-[var(--radius-surface)] border border-grey-200">
      <table className="w-full table-fixed text-left text-sm [overflow-wrap:anywhere]">
        <caption className="sr-only">GitHub accounts by organisation</caption>
        <thead className="bg-grey-100 text-xs text-grey-700">
          <tr className="border-b border-grey-200">
            <th scope="col" className="w-[30%] px-2 py-2 font-normal">Organisation</th>
            <th scope="col" className="w-[40%] px-2 py-2 font-normal">GitHub account</th>
            <th scope="col" className="w-[30%] px-2 py-2 font-normal">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-grey-200">
          {memberships.map((membership) => <OrganisationAccountRow key={membership.id} membership={membership}
            current={membership.workspace_slug === currentSlug} hasGlobalAccount={Boolean(globalAccount?.github_login)} />)}
          {globalAccount ? <AccountRow name="Global default" account={globalAccount} removable={Boolean(globalAccount.github_login)} source={globalAccount.github_login ? 'Shared fallback' : 'None'} /> : null}
        </tbody>
      </table>
    </div>}
    <p className="max-w-[46rem] text-xs text-grey-500">Organisation links override the global default. To link a different account, sign in to it on GitHub first. Repository access is managed in Administration.</p>
  </section>
}

function OrganisationAccountRow({ membership, current, hasGlobalAccount }: { membership: Membership; current: boolean; hasGlobalAccount: boolean }) {
  const identity = useQuery(organisationGitHubQuery(membership.workspace_slug))
  return <AccountRow name={membership.workspace_name} slug={membership.workspace_slug} current={current}
    account={identity.data ?? null} removable={identity.data?.source === 'organisation'}
    source={identity.data ? identity.data.source === 'organisation' ? 'Organisation link' : 'Global fallback' : hasGlobalAccount ? 'Global fallback unavailable' : 'None'}
    loading={identity.isPending} error={identity.error} retry={() => void identity.refetch()} retrying={identity.isFetching} />
}

function AccountRow({ name, slug, current, account, removable, source, loading, error, retry, retrying }: {
  name: string
  slug?: string
  current?: boolean
  account: GitHubAccount | null
  removable: boolean
  source: string
  loading?: boolean
  error?: Error | null
  retry?: () => void
  retrying?: boolean
}) {
  const client = useQueryClient()
  const actions = useRef<HTMLTableCellElement>(null)
  const link = useRef<HTMLAnchorElement>(null)
  const [confirming, setConfirming] = useState(false)
  const endpoint = slug ? `/w/${slug}/me/github` : '/me/github'
  const linkURL = slug ? `/api/v1/w/${slug}/me/github/link` : '/api/v1/auth/github/link'
  const linkLabel = slug ? `${account?.github_login ? 'Change' : 'Link'} GitHub account for ${name}` : 'Link GitHub profile'
  const removeLabel = slug ? `Remove organisation link for ${name}` : 'Unlink GitHub profile'
  const confirmLabel = slug ? `Confirm remove organisation link for ${name}` : 'Confirm unlink GitHub profile'
  const remove = useMutation({
    mutationFn: () => api.del(endpoint),
    onSuccess: async () => {
      await refreshPrivateQueries(client)
      setConfirming(false)
      // Row-owned refs become null on navigation or membership removal, so a late
      // response cannot move focus into a different page's account controls.
      requestAnimationFrame(() => link.current?.focus())
    },
  })
  const cancel = () => {
    setConfirming(false)
    requestAnimationFrame(() => actions.current?.querySelector<HTMLButtonElement>('[data-remove-trigger], [data-retry-trigger]')?.focus())
  }
  return <>
    <tr data-testid={slug ? `github-account-row-${slug}` : 'github-account-row-global'} className="align-top">
      <th scope="row" className="px-2 py-3 font-normal">
        {slug ? <a href={`/w/${slug}/settings/profile/github`} className="inline-flex min-h-10 items-center underline underline-offset-4">{name}</a>
          : <span className="block py-2">{name}</span>}
        {current ? <span className="block text-xs text-grey-700">Current organisation</span> : null}
      </th>
      <td className="space-y-1 px-2 py-3">
        {loading ? <span role="status" aria-label={`Loading GitHub account for ${name}`} className="text-grey-500">Loading…</span>
          : error ? <p role="alert" className="text-blocked">Could not load account.</p>
            : <>
              {account?.github_login ? <>
                <span className="font-medium">@{account.github_login}</span>
                {account.github_id != null ? <span className="block text-xs text-grey-700">ID {account.github_id}</span> : null}
              </> : <span className="text-grey-500">Not linked</span>}
              <span className="block text-xs text-grey-700">{source}</span>
            </>}
      </td>
      <td ref={actions} className="px-2 py-3">
        {error ? <Button data-retry-trigger className="min-h-10" aria-label={`Retry GitHub account for ${name}`} disabled={retrying} onClick={retry}>
          {retrying ? 'Retrying…' : 'Try again'}
        </Button> : !loading && !confirming ? <div className="flex flex-wrap gap-2">
          {slug || !account?.github_login ? <a ref={link} aria-label={linkLabel} href={linkURL}
            className={buttonClassName('secondary', 'inline-flex min-h-10 items-center justify-center no-underline')}
            onClick={async (event) => {
              event.preventDefault()
              const anchor = event.currentTarget
              await clearPrivateQueries(client)
              if (anchor.isConnected && link.current === anchor) navigateTo(linkURL)
            }}>{account?.github_login ? 'Change' : 'Link'}</a> : null}
          {removable ? <Button data-remove-trigger aria-label={removeLabel} disabled={remove.isPending} className="min-h-10" onClick={() => { remove.reset(); setConfirming(true) }}>Remove</Button> : null}
        </div> : null}
        {remove.isSuccess && !confirming ? <p role="status" className="mt-2 text-xs text-grey-700">{slug ? 'Organisation link removed.' : 'Global account removed.'}</p> : null}
      </td>
    </tr>
    {confirming ? <tr><td colSpan={3} className="px-3 py-3">
      <div className="space-y-2" role="group" aria-label={slug ? `Confirm organisation link removal for ${name}` : 'Confirm global GitHub unlink'}
        onKeyDown={(event) => { if (event.key === 'Escape' && !remove.isPending) { event.preventDefault(); cancel() } }}>
        <p className="font-medium">{slug ? `Remove the GitHub link for ${name}?` : `Remove the global default?`}</p>
        <p className="max-w-[46rem] text-xs text-grey-700">{slug
          ? 'Only this organisation override is removed. Your global account will be used as a fallback if available. Existing synced evidence remains. Other organisations and your global account are unchanged.'
          : 'This removes the shared fallback across all organisations. Future GitHub activity will not use your global fallback until you link it again. Organisation overrides are unchanged. Existing evidence remains.'}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" className="min-h-10" aria-label={remove.isPending ? 'Removing…' : confirmLabel} disabled={remove.isPending || Boolean(error) || loading || !removable} onClick={() => remove.mutate()}>{remove.isPending ? 'Removing…' : 'Remove link'}</Button>
          <Button className="min-h-10" autoFocus disabled={remove.isPending} onClick={cancel}>Cancel</Button>
        </div>
        {error ? <p className="text-xs text-grey-700">Refresh the account before removing the link.</p> : null}
        {remove.error ? <p role="alert" className="text-blocked">{remove.error.message} Try removing the link again, or cancel.</p> : null}
      </div>
    </td></tr> : null}
  </>
}
