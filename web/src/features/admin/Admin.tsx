import type { Membership } from '../../lib/types'
import { useSession } from '../auth/useSession'
import { useAdminData, type AdminPageId } from './adminPages'
import { AdminLayout } from './AdminLayout'
import { DangerPanel } from './DangerPanel'
import { GitHubPanel } from './GitHubPanel'
import { InvitePanel } from './InvitePanel'
import { MembersPanel } from './MembersPanel'
import { OrganisationPanel } from './OrganisationPanel'

/**
 * One Administration page. Each page is its own component with its own URL,
 * so a link to /admin/members opens Members alone rather than scrolling a
 * long page to it.
 */
export function Admin({ slug, page = 'general' }: { slug: string; page?: AdminPageId }) {
  return (
    <AdminLayout slug={slug} page={page}>
      {(workspace) => <AdminPage slug={slug} page={page} workspace={workspace} />}
    </AdminLayout>
  )
}

function AdminPage({ slug, page, workspace }: { slug: string; page: AdminPageId; workspace: Membership }) {
  const session = useSession(slug)
  // AdminLayout has already confirmed the admin role, and these read the same
  // cache entries its section counts use, so switching pages does not refetch.
  const { members, invites, repos } = useAdminData(slug, true)

  switch (page) {
    case 'general':
      return <OrganisationPanel slug={slug} workspace={workspace} />
    case 'members':
      return <MembersPanel slug={slug} selfId={session.user?.id} members={members} />
    case 'invitations':
      return <InvitePanel slug={slug} invites={invites} />
    case 'repositories':
      return <GitHubPanel slug={slug} repos={repos} />
    case 'danger':
      return <DangerPanel slug={slug} />
  }
}
