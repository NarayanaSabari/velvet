import { useQuery } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Invitation, Repo, WorkspaceMembership } from '../../lib/types'

export type AdminPageId = 'general' | 'members' | 'invitations' | 'repositories' | 'danger'

export interface AdminPage {
  id: AdminPageId
  label: string
  description: string
}

/** The Administration pages, in the order they appear in the section list. */
export const ADMIN_PAGES: AdminPage[] = [
  { id: 'general', label: 'General', description: 'The organisation’s name, and the address and ticket prefix fixed when it was created.' },
  { id: 'members', label: 'Members', description: 'People who can open this organisation, and what they can change.' },
  { id: 'invitations', label: 'Invitations', description: 'Invite someone by email. They join with the chosen role after following the link, which lasts 7 days.' },
  { id: 'repositories', label: 'Repositories', description: 'GitHub supplies pull requests and commits as evidence of work. Velvet only reads from GitHub and never changes a ticket because of it.' },
  { id: 'danger', label: 'Danger zone', description: 'Actions here cannot be undone.' },
]

export const ADMIN_PAGE_IDS = ADMIN_PAGES.map((page) => page.id)

/**
 * The queries behind the counts in the section list and the pages themselves.
 * Each page reads the same cache entries, so moving between pages is instant
 * and a change on one page updates the counts beside it.
 */
export function useAdminData(slug: string, enabled: boolean) {
  const members = useQuery({
    queryKey: ['memberships', slug],
    queryFn: () => api.get<{ memberships: WorkspaceMembership[] }>(`/w/${slug}/memberships`),
    enabled,
  })
  const invites = useQuery({
    queryKey: ['invites', slug],
    queryFn: () => api.get<{ invites: Invitation[] }>(`/w/${slug}/invites`),
    enabled,
  })
  const repos = useQuery({
    queryKey: ['repos', slug],
    queryFn: () => api.get<{ repos: Repo[] }>(`/w/${slug}/repos`),
    enabled,
  })
  return { members, invites, repos }
}
