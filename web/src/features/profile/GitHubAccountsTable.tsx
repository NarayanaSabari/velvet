import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { ErrorNote } from '../../ui/ErrorNote'
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'

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
    {memberships.length === 0 && !globalAccount ? <p className="text-grey-500">No organisations to show.</p> : <div className="border-b border-grey-200 [overflow-wrap:anywhere]">
      <Table aria-label="GitHub accounts by organisation" verticalAlign="top">
        <TableHeader>
          <TableRow isHeaderRow>
            <TableHeaderCell scope="col" className="w-[30%]">Organisation</TableHeaderCell>
            <TableHeaderCell scope="col" className="w-[40%]">GitHub account</TableHeaderCell>
            <TableHeaderCell scope="col" className="w-[30%]">Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {memberships.map((membership) => <OrganisationAccountRow key={membership.id} membership={membership}
            current={membership.workspace_slug === currentSlug} hasGlobalAccount={Boolean(globalAccount?.github_login)} />)}
          {globalAccount ? <AccountRow name="Global default" account={globalAccount} removable={Boolean(globalAccount.github_login)} source={globalAccount.github_login ? 'Shared fallback' : 'None'} /> : null}
        </TableBody>
      </Table>
    </div>}
    <p className="max-w-[46rem] text-xs text-grey-500">Organisation links override the global default. Choose Link or Change, then select the account on GitHub. This does not switch your Velvet organisation. Repository access is managed in Administration.</p>
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
    <TableRow data-testid={slug ? `github-account-row-${slug}` : 'github-account-row-global'}>
      <TableHeaderCell scope="row">
        {slug ? <a href={`/w/${slug}/settings/profile/github`} className="inline-flex min-h-11 items-center underline underline-offset-4 sm:min-h-10">{name}</a>
          : <span className="block py-2">{name}</span>}
        {current ? <span className="block text-xs text-grey-700">Current organisation</span> : null}
      </TableHeaderCell>
      <TableCell className="space-y-1">
        {loading ? <span role="status" aria-label={`Loading GitHub account for ${name}`} className="text-grey-500">Loading…</span>
          : error ? <ErrorNote>Could not load account.</ErrorNote>
            : <>
              {account?.github_login ? <>
                <span className="font-medium">@{account.github_login}</span>
                {account.github_id != null ? <span className="block text-xs text-grey-700">ID {account.github_id}</span> : null}
              </> : <span className="text-grey-500">Not linked</span>}
              <span className="block text-xs text-grey-700">{source}</span>
            </>}
      </TableCell>
      <TableCell ref={actions}>
        {error ? <Button data-retry-trigger className="min-h-10" aria-label={`Retry GitHub account for ${name}`} disabled={retrying} onClick={retry}>
          {retrying ? 'Retrying…' : 'Try again'}
        </Button> : !loading ? <div className="flex flex-wrap gap-2">
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
      </TableCell>
    </TableRow>
    <ConfirmDialog
      open={confirming}
      onClose={cancel}
      title={slug ? `Remove the GitHub link for ${name}?` : 'Remove the global default?'}
      description={slug
        ? 'Only this organisation override is removed. Your global account will be used as a fallback if available. Existing synced evidence remains. Other organisations and your global account are unchanged.'
        : 'This removes the shared fallback across all organisations. Future GitHub activity will not use your global fallback until you link it again. Organisation overrides are unchanged. Existing evidence remains.'}
      actionLabel="Remove link"
      pending={remove.isPending}
      error={error
        ? 'Refresh the account before removing the link.'
        : remove.error ? `${remove.error.message} Try removing the link again, or cancel.` : null}
      // A row that failed to refresh, or is no longer removable, is not acted on.
      onConfirm={() => { if (!error && !loading && removable) remove.mutate() }}
    />
  </>
}
