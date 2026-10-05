import { useQueries } from '@tanstack/react-query'

import type { Membership } from '../../lib/types'
import { Button } from '../../ui/Button'
import { SectionHeader } from '../../ui/PageHeader'
import { organisationGitHubQuery } from './organisationGitHub'

export function GitHubAccountsTable({ memberships, currentSlug, hasGlobalAccount }: {
  memberships: Membership[]
  currentSlug: string
  hasGlobalAccount: boolean
}) {
  const accounts = useQueries({
    queries: memberships.map((membership) => organisationGitHubQuery(membership.workspace_slug)),
  })

  return <section className="space-y-3" aria-labelledby="github-accounts-heading">
    <SectionHeader id="github-accounts-heading" title="GitHub accounts by organisation" />
    <p className="max-w-[46rem] text-grey-500">The account used to attribute your work in each organisation. Select an organisation to manage its link.</p>
    {memberships.length === 0 ? <p className="text-grey-500">No organisations to show.</p> : <div className="rounded-[var(--radius-surface)] border border-grey-200">
      <table className="w-full table-fixed text-left text-sm [overflow-wrap:anywhere]">
        <caption className="sr-only">GitHub accounts by organisation</caption>
        <thead className="bg-grey-100 text-xs text-grey-700">
          <tr className="border-b border-grey-200">
            <th scope="col" className="w-[35%] px-2 py-2 font-normal">Organisation</th>
            <th scope="col" className="w-[35%] px-2 py-2 font-normal">GitHub account</th>
            <th scope="col" className="w-[30%] px-2 py-2 font-normal">Link type</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-grey-200">
          {memberships.map((membership, index) => {
            const account = accounts[index]
            if (!account) return null
            return <tr key={membership.id} data-testid={`github-account-row-${membership.workspace_slug}`} className="align-top">
              <th scope="row" className="px-2 py-3 font-normal">
                <a href={`/w/${membership.workspace_slug}/settings/profile/github`} className="inline-flex min-h-10 items-center underline underline-offset-4">
                  {membership.workspace_name}
                </a>
                {membership.workspace_slug === currentSlug ? <span className="block text-xs text-grey-700">Current organisation</span> : null}
              </th>
              <td className="px-2 py-3">
                {account.isPending ? <span role="status" aria-label={`Loading GitHub account for ${membership.workspace_name}`} className="text-grey-500">Loading…</span>
                  : account.isError ? <div className="space-y-2">
                    <p role="alert" className="text-blocked">Could not load account.</p>
                    <Button aria-label={`Retry GitHub account for ${membership.workspace_name}`} disabled={account.isFetching} onClick={() => void account.refetch()}>
                      {account.isFetching ? 'Retrying…' : 'Try again'}
                    </Button>
                  </div>
                    : account.data ? <>
                      <span className="font-medium">@{account.data.github_login}</span>
                      <span className="block text-xs text-grey-700">ID {account.data.github_id}</span>
                    </> : <span className="text-grey-500">Not linked</span>}
              </td>
              <td className="px-2 py-3 text-xs text-grey-700">
                {account.isPending ? 'Pending' : account.isError ? 'Unavailable'
                  : account.data ? account.data.source === 'organisation' ? 'Organisation link' : 'Global fallback'
                    : hasGlobalAccount ? 'Global fallback unavailable' : 'None'}
              </td>
            </tr>
          })}
        </tbody>
      </table>
    </div>}
  </section>
}
