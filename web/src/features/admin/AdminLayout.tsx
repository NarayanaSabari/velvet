import type { ReactNode } from 'react'

import { NavLink } from '../../app/nav'
import type { Membership } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { SectionNav } from '../../ui/SectionNav'
import { LoadingState } from '../../ui/QueryState'
import { useSession } from '../auth/useSession'
import { ADMIN_PAGES, useAdminData, type AdminPageId } from './adminPages'

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
    return (
      <div className="w-full min-w-0">
        <PageHeader eyebrow="Administration" title="Admin access required" />
        <EmptyState
          title="Only admins can open this page"
          message="Only organisation admins can manage members and repository connections."
        />
        <NavLink to={`/w/${slug}`} className="mt-3 inline-block text-sm underline">Back to dashboard</NavLink>
      </div>
    )
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
          <SectionNav
            label="Administration sections"
            current={page}
            items={ADMIN_PAGES.map((item) => ({
              id: item.id,
              label: item.label,
              href: `/w/${slug}/admin/${item.id}`,
              count: counts[item.id],
              destructive: item.id === 'danger',
            }))}
          />
        </div>
        <div className="min-w-0">{children(session.workspace)}</div>
      </div>
    </div>
  )
}
