import { PROFILE_PAGES } from '../features/profile/profilePages'
import { ADMIN_PAGES } from '../features/admin/adminPages'

export function productPageTitle(pathname: string): string {
  if (pathname === '/me/worklog') return 'Work log'
  if (/^\/w\/[^/]+\/?$/.test(pathname)) return 'Dashboard'
  const profile = /\/settings\/profile(?:\/([^/]+))?\/?$/.exec(pathname)
  if (profile) {
    const page = PROFILE_PAGES.find((candidate) => candidate.id === (profile[1] ?? 'general'))
    return page ? `${page.label} · Profile` : 'Page not found'
  }
  if (/\/issues\/[^/]+\/?$/.test(pathname)) return 'Issue'
  if (/\/issues\/?$/.test(pathname)) return 'Issues'
  if (/\/sprints\/[^/]+\/?$/.test(pathname)) return 'Sprint'
  if (/\/sprints\/?$/.test(pathname)) return 'Sprints'
  if (/\/milestones\/[^/]+\/?$/.test(pathname)) return 'Milestone'
  if (/\/projects\/?$/.test(pathname)) return 'Projects'
  if (/\/feed\/?$/.test(pathname)) return 'Team feed'
  if (/\/mentions\/?$/.test(pathname)) return 'Mentions'
  if (/\/unlinked\/?$/.test(pathname)) return 'Unlinked PRs'
  if (/\/reports\/?$/.test(pathname)) return 'Reports'
  const admin = /\/admin(?:\/([^/]+))?\/?$/.exec(pathname)
  if (admin) return ADMIN_TITLES[admin[1] ?? 'general'] ?? 'Page not found'
  return 'Page not found'
}

const ADMIN_TITLES: Record<string, string> = Object.fromEntries(
  ADMIN_PAGES.map((page) => [page.id, `${page.label} · Administration`]),
)
