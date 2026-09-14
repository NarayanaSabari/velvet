import type { ReactNode } from 'react'

import { useSession } from '../features/auth/useSession'
import { SignIn } from '../features/auth/SignIn'
import { NewOrganisation } from '../features/orgs/NewOrganisation'
import { LeaveOrganisation } from '../features/orgs/LeaveOrganisation'
import { SignOutButton } from '../features/auth/SignOutButton'
import { Avatar } from '../ui/Avatar'
import { userLabel } from '../lib/userLabel'
import { NavLink } from './nav'

const NAV = [
  { label: 'Dashboard', path: '' },
  { label: 'Team feed', path: '/feed' },
  { label: 'Sprints', path: '/sprints' },
  { label: 'Mentions', path: '/mentions' },
  { label: 'Unlinked PRs', path: '/unlinked' },
  { label: 'Reports', path: '/reports' },
] as const

export function Shell({ slug, children }: { slug?: string; children: ReactNode }) {
  const { user, memberships, workspace, isLoading, isSignedIn } =
    useSession(slug)

  // Rendering nothing session-dependent while loading is what stops the
  // sign-in prompt flashing on every refresh.
  if (isLoading) return <div className="p-4 text-grey-500">Loading…</div>
  if (!isSignedIn) return <SignIn />
  if (!slug && memberships.length === 0) return <NewOrganisation />
  if (!workspace) {
    return (
      <div className="mx-auto mt-24 max-w-sm border border-grey-200 px-6 py-8">
        <h1 className="text-lg">Organisation not found</h1>
        <p className="mt-2 text-sm text-grey-500">You do not have access to this organisation.</p>
        <NavLink to="/" className="mt-3 block underline">Your organisations</NavLink>
        <SignOutButton />
      </div>
    )
  }

  const base = `/w/${workspace.workspace_slug}`

  return (
    <div className="flex min-h-screen flex-col sm:flex-row">
      <nav className="w-full shrink-0 border-b border-grey-200 p-3 sm:min-h-screen sm:w-48 sm:border-r sm:border-b-0">
        <div className="mb-3 sm:mb-4">
          {memberships.length > 1 ? (
            <label className="block">
              <span className="sr-only">Organisation</span>
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

        <ul className="flex flex-wrap gap-x-3 gap-y-1 sm:block sm:space-y-1">
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
          {workspace.role === 'admin' ? (
            <li>
              <NavLink
                to={`${base}/admin`}
                className="block px-1 py-0.5 transition-colors hover:bg-grey-100"
              >
                Administration
              </NavLink>
            </li>
          ) : null}
        </ul>
        <NavLink to="/orgs/new" className="mt-4 block px-1 underline">New organisation</NavLink>

        <div className="mt-3 flex items-center gap-3 border-t border-grey-200 pt-3 text-sm sm:mt-6 sm:block">
          <span className="flex items-center gap-2">
            <Avatar user={user} />
            <span className="truncate text-grey-700">{userLabel(user)}</span>
          </span>
          <SignOutButton />
          <NavLink to={`${base}/settings/profile`} className="mt-2 block underline">Profile</NavLink>
          <LeaveOrganisation slug={workspace.workspace_slug} />
        </div>
      </nav>

      <main className="min-w-0 flex-1 p-3 sm:p-4">{children}</main>
    </div>
  )
}
