import type { ReactNode } from 'react'

import { useSession } from '../features/auth/useSession'
import { SignIn } from '../features/auth/SignIn'
import { NotInvited } from '../features/auth/NotInvited'
import { Avatar } from '../ui/Avatar'
import { NavLink } from './nav'

const NAV = [
  { label: 'Dashboard', path: '' },
  { label: 'Team feed', path: '/feed' },
  { label: 'Sprints', path: '/sprints' },
  { label: 'Unlinked PRs', path: '/unlinked' },
  { label: 'Reports', path: '/reports' },
] as const

export function Shell({ slug, children }: { slug?: string; children: ReactNode }) {
  const { user, memberships, workspace, isLoading, isSignedIn, isNotInvited } =
    useSession(slug)

  // Rendering nothing session-dependent while loading is what stops the
  // sign-in prompt flashing on every refresh.
  if (isLoading) return <div className="p-4 text-grey-500">Loading…</div>
  if (isNotInvited) return <NotInvited />
  if (!isSignedIn || !workspace) return <SignIn />

  const base = `/w/${workspace.workspace_slug}`

  return (
    <div className="flex min-h-screen">
      <nav className="w-48 shrink-0 border-r border-grey-200 p-3">
        <div className="mb-4">
          {memberships.length > 1 ? (
            <label className="block">
              <span className="sr-only">Workspace</span>
              <select
                className="w-full border border-grey-300 bg-paper px-1 py-0.5 text-sm"
                value={workspace.workspace_slug}
                onChange={(e) => {
                  window.location.href = `/w/${e.target.value}`
                }}
              >
                {memberships.map((m) => (
                  <option key={m.id} value={m.workspace_slug}>
                    {m.workspace_name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="text-ink">{workspace.workspace_name}</span>
          )}
        </div>

        <ul className="space-y-1">
          {NAV.map((item) => (
            <li key={item.label}>
              <NavLink
                to={base + item.path}
                className="block px-1 py-0.5 transition-colors hover:bg-grey-100"
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="mt-6 border-t border-grey-200 pt-3 text-sm">
          <span className="flex items-center gap-2">
            <Avatar user={user} />
            <span className="truncate text-grey-700">{user?.github_login}</span>
          </span>
          <a className="mt-2 inline-block text-grey-500 underline" href="/api/v1/auth/logout">
            Sign out
          </a>
        </div>
      </nav>

      <main className="min-w-0 flex-1 p-4">{children}</main>
    </div>
  )
}
