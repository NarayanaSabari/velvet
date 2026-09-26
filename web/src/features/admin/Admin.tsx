import { useQuery } from '@tanstack/react-query'

import { useSession } from '../auth/useSession'
import { api } from '../../lib/api'
import type { Invitation, Repo, WorkspaceMembership } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { PageHeader } from '../../ui/PageHeader'
import { LoadingState } from '../../ui/QueryState'
import { OrganisationPanel } from './OrganisationPanel'
import { InvitePanel } from './InvitePanel'
import { MembersPanel } from './MembersPanel'
import { GitHubPanel } from './GitHubPanel'
import { DangerPanel } from './DangerPanel'

interface Section {
  id: string
  label: string
  count?: number
  danger?: boolean
}

/**
 * Jump links with live counts, so an admin sees the shape of the organisation
 * at a glance and reaches any section without scrolling past the others.
 */
function SectionNav({ sections }: { sections: Section[] }) {
  return (
    <nav aria-label="Administration sections" className="lg:sticky lg:top-4">
      <ul className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className={`flex min-h-10 items-center justify-between gap-3 rounded-[var(--radius-control)] px-2.5 text-sm no-underline hover:bg-grey-100 lg:min-h-8 ${section.danger ? 'text-blocked' : 'text-grey-700 hover:text-ink'}`}
            >
              <span>{section.label}</span>
              {section.count !== undefined ? (
                <span className="rounded-full bg-grey-100 px-1.5 text-xs tabular-nums text-grey-700">{section.count}</span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function Admin({ slug }: { slug: string }) {
  const session = useSession(slug)
  const isAdmin = session.workspace?.role === 'admin'
  const members = useQuery({
    queryKey: ['memberships', slug],
    queryFn: () => api.get<{ memberships: WorkspaceMembership[] }>(`/w/${slug}/memberships`),
    enabled: isAdmin,
  })
  const invites = useQuery({
    queryKey: ['invites', slug],
    queryFn: () => api.get<{ invites: Invitation[] }>(`/w/${slug}/invites`),
    enabled: isAdmin,
  })
  const repos = useQuery({
    queryKey: ['repos', slug],
    queryFn: () => api.get<{ repos: Repo[] }>(`/w/${slug}/repos`),
    enabled: isAdmin,
  })

  if (session.isLoading) return <LoadingState />
  if (!isAdmin) return <EmptyState title="Admin access required" message="Only organisation admins can manage members and repository connections." />

  const sections: Section[] = [
    { id: 'organisation', label: 'Organisation' },
    { id: 'members', label: 'Members', count: members.data?.memberships.length },
    { id: 'invitations', label: 'Invitations', count: invites.data?.invites.length },
    { id: 'repositories', label: 'Repositories', count: repos.data?.repos.filter((repo) => !repo.disconnected_at).length },
    { id: 'danger-zone', label: 'Danger zone', danger: true },
  ]

  return (
    <div className="w-full min-w-0">
      <PageHeader
        title="Administration"
        description="Manage who can enter this organisation and which GitHub repositories supply work evidence."
      />
      <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <div className="min-w-0">
          <SectionNav sections={sections} />
        </div>
        <div className="min-w-0">
          <OrganisationPanel slug={slug} workspace={session.workspace!} />
          <MembersPanel slug={slug} selfId={session.user?.id} members={members} />
          <InvitePanel slug={slug} invites={invites} />
          <GitHubPanel slug={slug} repos={repos} />
          <DangerPanel slug={slug} />
        </div>
      </div>
    </div>
  )
}
