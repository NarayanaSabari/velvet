import type { ReactNode } from 'react'

import { NavLink } from '../../app/nav'
import type { Membership } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { LoadingState } from '../../ui/QueryState'
import { useSession } from '../auth/useSession'
import { ADMIN_PAGES, useAdminData, type AdminPageId } from './adminPages'

function AdminNav({ slug, counts }: { slug: string; counts: Partial<Record<AdminPageId, number>> }) {
  return (
    <nav aria-label="Administration sections" className="lg:sticky lg:top-4">
      <ul className="flex flex-wrap gap-1 border-b border-grey-200 pb-2 lg:flex-col lg:flex-nowrap lg:gap-0.5 lg:border-b-0 lg:pb-0">
        {ADMIN_PAGES.map((page) => (
          <li key={page.id} className="shrink-0">
            <NavLink
              to={`/w/${slug}/admin/${page.id}`}
              className={`group flex min-h-10 items-center justify-between gap-3 whitespace-nowrap rounded-[var(--radius-control)] border border-transparent px-2.5 text-sm no-underline hover:bg-grey-100 lg:min-h-8 ${page.id === 'danger' ? 'text-blocked' : 'text-grey-700 hover:text-ink'}`}
              activeClassName="border-grey-200 bg-grey-100 font-medium !text-ink"
            >
              <span className={page.id === 'danger' ? 'group-aria-[current=page]:text-blocked' : undefined}>{page.label}</span>
              {counts[page.id] !== undefined ? (
                <span className="rounded-full bg-paper px-1.5 text-xs tabular-nums text-grey-700 group-hover:bg-grey-200 lg:bg-grey-100 lg:group-aria-[current=page]:bg-paper">
                  {counts[page.id]}
                </span>
              ) : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/**
 * Administration is a small settings area: one page per concern, with the
 * section list beside it on wide screens and above it on narrow ones. The
 * admin check lives here, so no page can render or fetch for a non-admin.
 */
export function AdminLayout({ slug, page, children }: {
  slug: string
  page: AdminPageId
  children: (workspace: Membership) => ReactNode
}) {
  const session = useSession(slug)
  const isAdmin = session.workspace?.role === 'admin'
  const { members, invites, repos } = useAdminData(slug, isAdmin)

  if (session.isLoading) return <LoadingState />
  if (!isAdmin || !session.workspace) {
    return <EmptyState title="Admin access required" message="Only organisation admins can manage members and repository connections." />
  }

  const current = ADMIN_PAGES.find((candidate) => candidate.id === page)!
  const counts: Partial<Record<AdminPageId, number>> = {
    members: members.data?.memberships.length,
    invitations: invites.data?.invites.length,
    repositories: repos.data?.repos.filter((repo) => !repo.disconnected_at).length,
  }

  return (
    <div className="w-full min-w-0">
      <PageHeader
        eyebrow="Administration"
        title={current.label}
        description={current.description}
      />
      <div className="grid gap-4 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <div className="min-w-0">
          <AdminNav slug={slug} counts={counts} />
        </div>
        <div className="min-w-0">{children(session.workspace)}</div>
      </div>
    </div>
  )
}
