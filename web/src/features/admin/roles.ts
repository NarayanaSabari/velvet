import type { Role } from '../../lib/types'

export const ROLES: Role[] = ['admin', 'member', 'viewer']

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

/** What each role can do, in the words an admin needs when choosing one. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Everything a member can do, plus members, invitations, GitHub, and deleting the organisation.',
  member: 'Creates and updates tickets, sprints, and projects, and logs work.',
  viewer: 'Reads everything but cannot change it. Their agents can read but not log work.',
}

const HOUR = 60 * 60 * 1000

/** An invitation that lapses within a day is worth resending before it does. */
export function expiresSoon(expiresAt: string, now = Date.now()): boolean {
  const remaining = new Date(expiresAt).getTime() - now
  return remaining > 0 && remaining < 24 * HOUR
}
