import { useState, type ReactNode } from 'react'

import { useSession } from '../features/auth/useSession'
import { SignIn } from '../features/auth/SignIn'
import { NewOrganisation } from '../features/orgs/NewOrganisation'
import { LeaveOrganisation } from '../features/orgs/LeaveOrganisation'
import { SignOutButton } from '../features/auth/SignOutButton'
import { CommandPalette } from '../features/palette/CommandPalette'
import { COMMAND_PALETTE_TEST_IDS } from '../features/palette/paletteTestIds'
import { Avatar } from '../ui/Avatar'
import { LoadingState } from '../ui/QueryState'
import { userLabel } from '../lib/userLabel'
import { NavLink } from './nav'

const NAV = [
  { label: 'Dashboard', path: '' },
  { label: 'Issues', path: '/issues' },
  { label: 'Projects', path: '/projects' },
  { label: 'Team feed', path: '/feed' },
  { label: 'Sprints', path: '/sprints' },
  { label: 'Mentions', path: '/mentions' },
  { label: 'Unlinked PRs', path: '/unlinked' },
  { label: 'Reports', path: '/reports' },
] as const

const MOBILE_NAV = [
  { label: 'Dashboard', path: '' },
  { label: 'Issues', path: '/issues' },
  { label: 'Sprints', path: '/sprints' },
  { label: 'Mentions', path: '/mentions' },
] as const

const NAV_ITEM =
  'flex min-h-7 items-center rounded-[6px] border-l-2 border-transparent px-2 py-1 text-sm hover:bg-grey-100 focus-visible:bg-grey-100'
const NAV_ACTIVE = 'border-l-ink bg-grey-100 font-medium'
const MENU_ITEM =
  'block rounded-[6px] px-2 py-1.5 text-sm hover:bg-grey-100 focus-visible:bg-grey-100'
const TAB_ITEM =
  'flex min-h-12 flex-col items-center justify-center rounded-[6px] px-1 py-1 text-xs leading-tight text-grey-700 hover:bg-grey-100 focus-visible:bg-grey-100'

function WorkspaceSwitcher({
  memberships,
  workspaceSlug,
  workspaceName,
}: {
  memberships: { id: string; workspace_slug: string; workspace_name: string }[]
  workspaceSlug: string
  workspaceName: string
}) {
  if (memberships.length <= 1) {
    return <span className="block truncate font-medium text-ink">{workspaceName}</span>
  }

  return (
    <label className="block">
      <span className="sr-only">Organisation</span>
      <select
        aria-label="Organisation"
        className="w-full rounded-[6px] border border-grey-300 bg-paper px-2 py-1 text-sm text-ink"
        value={workspaceSlug}
        onChange={(event) => {
          window.location.href = `/w/${event.target.value}`
        }}
      >
        {memberships.map((membership) => (
          <option key={membership.id} value={membership.workspace_slug}>
            {membership.workspace_name}
          </option>
        ))}
      </select>
    </label>
  )
}

function MenuLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink to={to} className={MENU_ITEM} activeClassName="bg-grey-100 font-medium">
      {children}
    </NavLink>
  )
}

function AccountMenu({
  base,
  user,
  workspaceSlug,
}: {
  base: string
  user: Parameters<typeof Avatar>[0]['user']
  workspaceSlug: string
}) {
  const [open, setOpen] = useState(false)
  const [openedByKeyboard, setOpenedByKeyboard] = useState(false)
  const label = userLabel(user)

  return (
    <div className="relative">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-[6px] px-1 py-1.5 text-left text-sm hover:bg-grey-100 focus-visible:bg-grey-100"
        aria-label="Open account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls="account-menu"
        onClick={(event) => {
          setOpenedByKeyboard(event.detail === 0)
          setOpen((isOpen) => !isOpen)
        }}
      >
        <Avatar user={user} size="md" />
        <span className="min-w-0 flex-1 truncate text-grey-700">{label}</span>
        <span aria-hidden="true" className="text-grey-500">
          {open ? '−' : '+'}
        </span>
      </button>

      <div
        id="account-menu"
        role="menu"
        inert={!open}
        className={`absolute bottom-[calc(100%+0.5rem)] left-0 z-40 w-52 origin-bottom-left rounded-[8px] border border-grey-200 bg-paper p-1 ${
          openedByKeyboard ? 'transition-none' : 'transition-[opacity,transform] duration-[150ms] ease-[var(--ease-out)]'
        } ${
          open
            ? 'pointer-events-auto visible scale-100 opacity-100'
            : 'pointer-events-none invisible scale-[0.97] opacity-0'
        }`}
      >
        <MenuLink to={`${base}/settings/profile`}>Profile</MenuLink>
        <MenuLink to="/orgs/new">New organisation</MenuLink>
        <div className="px-2 py-1.5 text-sm">
          <LeaveOrganisation slug={workspaceSlug} />
        </div>
        <div className="px-2 py-1.5 text-sm">
          <SignOutButton />
        </div>
      </div>
    </div>
  )
}

function MoreMenu({
  base,
  isAdmin,
  workspaceSlug,
}: {
  base: string
  isAdmin: boolean
  workspaceSlug: string
}) {
  const [open, setOpen] = useState(false)
  const [openedByKeyboard, setOpenedByKeyboard] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        className={TAB_ITEM}
        aria-label="More"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls="mobile-more-menu"
        onClick={(event) => {
          setOpenedByKeyboard(event.detail === 0)
          setOpen((isOpen) => !isOpen)
        }}
      >
        <span aria-hidden="true" className="text-base leading-none">
          {open ? '−' : '+'}
        </span>
        <span>More</span>
      </button>

      <div
        id="mobile-more-menu"
        role="menu"
        aria-hidden={!open}
        className={`absolute bottom-[calc(100%+0.5rem)] right-0 z-40 w-56 origin-bottom-right rounded-[8px] border border-grey-200 bg-paper p-1 ${
          openedByKeyboard ? 'transition-none' : 'transition-[opacity,transform] duration-[150ms] ease-[var(--ease-out)]'
        } ${
          open
            ? 'pointer-events-auto visible scale-100 opacity-100'
            : 'pointer-events-none invisible scale-[0.97] opacity-0'
        }`}
      >
        <MenuLink to={`${base}/feed`}>Team feed</MenuLink>
        <MenuLink to={`${base}/projects`}>Projects</MenuLink>
        <MenuLink to={`${base}/unlinked`}>Unlinked PRs</MenuLink>
        <MenuLink to={`${base}/reports`}>Reports</MenuLink>
        {isAdmin ? <MenuLink to={`${base}/admin`}>Administration</MenuLink> : null}
        <div className="my-1 border-t border-grey-200" />
        {/* Outside the workspace: the work log spans every organisation. */}
        <MenuLink to="/me/worklog">My work log</MenuLink>
        <MenuLink to={`${base}/settings/profile`}>Profile</MenuLink>
        <MenuLink to="/orgs/new">New organisation</MenuLink>
        <div className="px-2 py-1.5 text-sm">
          <LeaveOrganisation slug={workspaceSlug} />
        </div>
        <div className="px-2 py-1.5 text-sm">
          <SignOutButton />
        </div>
      </div>
    </div>
  )
}

export function Shell({
  slug,
  children,
  navigate,
}: {
  slug?: string
  children: ReactNode
  navigate?: (to: string) => void
}) {
  const { user, memberships, workspace, isLoading, isSignedIn } =
    useSession(slug)
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Rendering nothing session-dependent while loading is what stops the
  // sign-in prompt flashing on every refresh.
  if (isLoading) return <div className="p-4"><LoadingState /></div>
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
  const navigateTo = navigate ?? ((to: string) => {
    // Shell is also rendered directly in unit tests without a router provider.
    // Keep that harness navigable without forcing a full-page reload.
    window.history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  return (
    <div className="min-h-screen bg-paper sm:flex sm:items-start">
      <aside
        className="hidden w-full shrink-0 border-b border-grey-200 p-3 sm:sticky sm:top-0 sm:flex sm:h-screen sm:max-h-screen sm:w-48 sm:flex-col sm:overflow-hidden sm:border-r sm:border-b-0"
        data-testid="desktop-sidebar"
      >
        <div className="mb-4 shrink-0" data-testid="desktop-sidebar-header">
          <WorkspaceSwitcher
            memberships={memberships}
            workspaceSlug={workspace.workspace_slug}
            workspaceName={workspace.workspace_name}
          />
        </div>

        <nav
          aria-label="Workspace navigation"
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="desktop-sidebar-nav"
        >
          <ul className="space-y-1">
            {NAV.map((item) => (
              <li key={item.label}>
                <NavLink
                  to={base + item.path}
                  className={NAV_ITEM}
                  activeClassName={NAV_ACTIVE}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
            {workspace.role === 'admin' ? (
              <li>
                <NavLink
                  to={`${base}/admin`}
                  className={NAV_ITEM}
                  activeClassName={NAV_ACTIVE}
                >
                  Administration
                </NavLink>
              </li>
            ) : null}
            {/* Separated because it leaves the workspace: the work log spans
                every organisation this person belongs to. */}
            <li className="pt-2">
              <NavLink to="/me/worklog" className={NAV_ITEM} activeClassName={NAV_ACTIVE}>
                My work log
              </NavLink>
            </li>
          </ul>
        </nav>

        <div className="mt-auto shrink-0 border-t border-grey-200 pt-3" data-testid="desktop-sidebar-footer">
          <button
            type="button"
            data-testid={COMMAND_PALETTE_TEST_IDS.trigger}
            aria-label="Open command palette (⌘K)"
            className="mb-2 flex w-full items-center justify-between rounded-[6px] px-2 py-1.5 text-left text-xs text-grey-500 hover:bg-grey-100 hover:text-ink"
            onClick={() => setPaletteOpen(true)}
          >
            <span>Command palette</span>
            <kbd className="rounded border border-grey-300 px-1 py-0.5 font-mono text-xs">⌘K</kbd>
          </button>
          <AccountMenu
            base={base}
            user={user}
            workspaceSlug={workspace.workspace_slug}
          />
        </div>
      </aside>

      <header className="border-b border-grey-200 p-3 sm:hidden">
        <WorkspaceSwitcher
          memberships={memberships}
          workspaceSlug={workspace.workspace_slug}
          workspaceName={workspace.workspace_name}
        />
      </header>

      <main className="min-w-0 flex-1 px-3 pb-24 pt-4 sm:p-4">{children}</main>

      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-grey-200 bg-paper sm:hidden"
      >
        <div className="grid grid-cols-5 gap-1 px-2 pt-1 pb-[calc(0.25rem+env(safe-area-inset-bottom))]">
          {MOBILE_NAV.map((item) => (
            <NavLink
              key={item.label}
              to={base + item.path}
              className={TAB_ITEM}
              activeClassName="bg-grey-100 font-medium text-ink"
            >
              {item.label}
            </NavLink>
          ))}
          <MoreMenu
            base={base}
            isAdmin={workspace.role === 'admin'}
            workspaceSlug={workspace.workspace_slug}
          />
        </div>
      </nav>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        slug={workspace.workspace_slug}
        role={workspace.role}
        memberships={memberships}
        navigate={navigateTo}
      />
    </div>
  )
}
