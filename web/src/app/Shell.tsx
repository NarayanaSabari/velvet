import { ErrorNote } from '../ui/ErrorNote'
import { useState, type MouseEventHandler, type ReactNode } from 'react'
import { DropdownMenu, DropdownMenuDivider, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Selector } from '@astryxdesign/core/Selector'
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'

import { useSession } from '../features/auth/useSession'
import { useStream } from '../lib/useStream'
import { SignIn } from '../features/auth/SignIn'
import { Onboarding } from '../features/onboarding/Onboarding'
import { LeaveOrganisationDialog } from '../features/orgs/LeaveOrganisation'
import { SignOutButton, useSignOut } from '../features/auth/SignOutButton'
import { CommandPalette } from '../features/palette/CommandPalette'
import { COMMAND_PALETTE_TEST_IDS } from '../features/palette/paletteTestIds'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { LoadingState } from '../ui/QueryState'
import { userLabel } from '../lib/userLabel'
import type { Membership, Role } from '../lib/types'
import { NavLink } from './nav'
import { isNavLinkActive } from './navActive'

interface NavItem {
  label: string
  path: string
  icon: IconName
}

// Planning surfaces first, then the streams of what happened. The work log is
// kept apart because it leaves this organisation and spans every one.
const WORKSPACE_NAV: NavItem[] = [
  { label: 'Dashboard', path: '', icon: 'dashboard' },
  { label: 'Issues', path: '/issues', icon: 'issues' },
  { label: 'Projects', path: '/projects', icon: 'projects' },
  { label: 'Sprints', path: '/sprints', icon: 'sprints' },
  { label: 'Reports', path: '/reports', icon: 'reports' },
]
const ADMIN_NAV: NavItem = { label: 'Administration', path: '/admin', icon: 'admin' }
const ACTIVITY_NAV: NavItem[] = [
  { label: 'Team feed', path: '/feed', icon: 'feed' },
  { label: 'Mentions', path: '/mentions', icon: 'mentions' },
  { label: 'Unlinked PRs', path: '/unlinked', icon: 'pullRequest' },
]

const MOBILE_NAV: NavItem[] = [
  { label: 'Dashboard', path: '', icon: 'dashboard' },
  { label: 'Issues', path: '/issues', icon: 'issues' },
  { label: 'Sprints', path: '/sprints', icon: 'sprints' },
  { label: 'Mentions', path: '/mentions', icon: 'mentions' },
]

const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', member: 'Member', viewer: 'Viewer' }

// The sidebar sits on the quiet grey surface. Hover steps one shade darker,
// and the current page lifts onto a bordered paper surface with heavier type,
// so selection is carried by shape and weight rather than by fill alone.
// Supporting text on this surface uses grey-700: grey-500 on grey-100 falls
// below 4.5:1 in the light scheme.
const SIDEBAR_HOVER = 'hover:bg-grey-200/60 focus-visible:bg-grey-200/60'
const TAB_ITEM =
  'group flex min-h-12 flex-col items-center justify-center gap-1 rounded-[var(--radius-control)] px-1 py-1 text-xs leading-tight text-grey-700 hover:bg-grey-100 focus-visible:bg-grey-100'
const TAB_ICON = 'size-5 shrink-0 text-grey-500 group-aria-[current=page]:text-ink'

function shortcutLabel() {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent
  return /Mac|iPhone|iPad/.test(platform) ? '⌘K' : 'Ctrl K'
}

function WorkspaceMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-ink text-sm font-semibold text-paper"
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

function WorkspaceSwitcher({
  memberships,
  workspace,
}: {
  memberships: Membership[]
  workspace: Membership
}) {
  const identity = (
    <>
      <WorkspaceMark name={workspace.workspace_name} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium text-ink">{workspace.workspace_name}</span>
        <span className="block truncate text-xs text-grey-700">{ROLE_LABEL[workspace.role]}</span>
      </span>
    </>
  )

  if (memberships.length <= 1) {
    return <div className="flex min-w-0 items-center gap-2.5 p-1">{identity}</div>
  }

  // Astryx's dropdown is the control. Its closed state shows the identity
  // row, and choosing an organisation loads that organisation's pages.
  return (
    <Selector
      label="Organisation"
      isLabelHidden
      variant="ghost"
      width="100%"
      value={workspace.workspace_slug}
      data-value={workspace.workspace_slug}
      data-option-values={JSON.stringify(memberships.map((membership) => membership.workspace_slug))}
      options={memberships.map((membership) => ({ value: membership.workspace_slug, label: membership.workspace_name }))}
      renderValue={() => <span className="flex min-w-0 items-center gap-2.5 text-left">{identity}</span>}
      onChange={(value) => {
        if (value && value !== workspace.workspace_slug) window.location.href = `/w/${value}`
      }}
    />
  )
}

/**
 * Lets Astryx's nav items render through Velvet's own link, so navigation
 * stays inside the router. Astryx has already decided whether the item is
 * current and says so with aria-current.
 */
function SideNavLink({ href, to, children, className, onClick, ...attributes }: {
  href?: string
  to?: string
  children?: ReactNode
  className?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
  [attribute: string]: unknown
}) {
  return (
    <NavLink
      to={to ?? href ?? '#'}
      className={className}
      onClick={onClick}
      current={attributes['aria-current'] === 'page'}
      attributes={attributes}
    >
      {children}
    </NavLink>
  )
}

function SidebarItem({ to, item, alsoActiveFor = [] }: { to: string; item: NavItem; alsoActiveFor?: string[] }) {
  return (
    <SideNavItem
      label={item.label}
      href={to}
      as={SideNavLink}
      icon={<Icon name={item.icon} className="size-4 shrink-0" />}
      isSelected={[to, ...alsoActiveFor].some((path) => isNavLinkActive(path))}
    />
  )
}

/**
 * The two actions every menu ends with. Leaving asks first, in a dialog; a
 * failed sign-out is reported beside the menu that offered it.
 */
function useSessionActions(workspaceSlug: string) {
  const [leaving, setLeaving] = useState(false)
  const { signOut, failed } = useSignOut()
  const items = (
    <>
      <DropdownMenuDivider />
      <DropdownMenuItem label="Leave organisation" variant="destructive" onClick={() => setLeaving(true)} />
      <DropdownMenuItem label="Sign out" onClick={() => void signOut()} />
    </>
  )
  const extras = (
    <>
      <LeaveOrganisationDialog slug={workspaceSlug} isOpen={leaving} onOpenChange={setLeaving} />
      {failed ? <ErrorNote className="px-2 pt-1">Could not sign out. Try again.</ErrorNote> : null}
    </>
  )
  return { items, extras }
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
  const label = userLabel(user)
  const session = useSessionActions(workspaceSlug)

  return (
    <>
      <DropdownMenu
        placement="above"
        menuWidth="13rem"
        renderTrigger={(trigger) => (
          <button
            {...trigger}
            type="button"
            className={`flex w-full items-center gap-2.5 rounded-[var(--radius-control)] p-1 text-left ${SIDEBAR_HOVER}`}
            aria-label="Open account menu"
          >
            <Avatar user={user} size="lg" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium text-ink">{label}</span>
              {user?.email && user.email !== label ? (
                <span className="block truncate text-xs text-grey-700">{user.email}</span>
              ) : null}
            </span>
            <Icon name="selector" className="size-4 shrink-0 text-grey-500" />
          </button>
        )}
      >
        <DropdownMenuItem label="Profile" href={`${base}/settings/profile`} />
        <DropdownMenuItem label="New organisation" href="/orgs/new" />
        {session.items}
      </DropdownMenu>
      {session.extras}
    </>
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
  const session = useSessionActions(workspaceSlug)
  // A button is not a page, so it does not take aria-current. It carries the
  // selected look of a tab and a description saying the current page is inside.
  const currentInside = [
    `${base}/feed`, `${base}/projects`, `${base}/unlinked`, `${base}/reports`,
    `${base}/admin`, `${base}/settings/profile`, '/me/worklog',
  ].some((to) => isNavLinkActive(to))

  return (
    <div className="relative">
      <DropdownMenu
        placement="above"
        alignment="end"
        menuWidth="14rem"
        menuMaxHeight={560}
        renderTrigger={(trigger) => (
          <button
            {...trigger}
            type="button"
            className={`${TAB_ITEM} w-full aria-expanded:bg-grey-100 aria-expanded:text-ink${currentInside ? ' bg-grey-100 font-medium text-ink' : ''}`}
            data-active={currentInside ? 'true' : undefined}
            aria-label="More"
            aria-describedby={currentInside ? 'mobile-more-current' : undefined}
          >
            <Icon name="more" className={`${TAB_ICON}${currentInside ? ' text-ink' : ''}`} />
            <span>More</span>
          </button>
        )}
      >
        <DropdownMenuItem label="Team feed" href={`${base}/feed`} />
        <DropdownMenuItem label="Projects" href={`${base}/projects`} />
        <DropdownMenuItem label="Unlinked PRs" href={`${base}/unlinked`} />
        <DropdownMenuItem label="Reports" href={`${base}/reports`} />
        {isAdmin ? <DropdownMenuItem label="Administration" href={`${base}/admin`} /> : null}
        <DropdownMenuDivider />
        {/* Outside the workspace: the work log spans every organisation. */}
        <DropdownMenuItem label="My work log" href="/me/worklog" />
        <DropdownMenuItem label="Profile" href={`${base}/settings/profile`} />
        <DropdownMenuItem label="New organisation" href="/orgs/new" />
        {session.items}
      </DropdownMenu>
      {currentInside ? <span id="mobile-more-current" hidden>Current page is in this menu</span> : null}
      {session.extras}
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
  useStream(isSignedIn && workspace && slug ? workspace.workspace_slug : undefined)

  // Rendering nothing session-dependent while loading is what stops the
  // sign-in prompt flashing on every refresh.
  if (isLoading) return <div className="p-4"><LoadingState /></div>
  if (!isSignedIn) return <SignIn />
  if (!slug && memberships.length === 0) return <Onboarding />
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
  const shortcut = shortcutLabel()
  const navigateTo = navigate ?? ((to: string) => {
    // Shell is also rendered directly in unit tests without a router provider.
    // Keep that harness navigable without forcing a full-page reload.
    window.history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  return (
    <div className="min-h-screen bg-paper sm:flex sm:items-start">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-[var(--radius-control)] border border-ink bg-paper px-3 py-2 text-sm focus:fixed focus:top-2 focus:left-2 focus:not-sr-only focus:inline-flex focus:min-h-11 focus:items-center"
      >
        Skip to content
      </a>
      <aside
        className="hidden shrink-0 border-grey-200 bg-grey-100 sm:sticky sm:top-0 sm:flex sm:h-screen sm:max-h-screen sm:w-52 sm:flex-col sm:overflow-hidden sm:border-r xl:w-60"
        data-testid="desktop-sidebar"
      >
        <SideNav
          aria-label="Workspace navigation"
          data-testid="desktop-sidebar-nav"
          // Velvet's frame sets the sidebar's width; Astryx's nav fills it.
          className="h-full w-full min-w-0"
          header={(
            <div className="space-y-3" data-testid="desktop-sidebar-header">
              <WorkspaceSwitcher memberships={memberships} workspace={workspace} />
              <Button
                className="w-full justify-start"
                data-testid={COMMAND_PALETTE_TEST_IDS.trigger}
                aria-label="Search"
                aria-keyshortcuts="Meta+K Control+K"
                onClick={() => setPaletteOpen(true)}
              >
                <span className="flex w-full items-center gap-2">
                  <Icon name="search" className="size-4 shrink-0 text-grey-500" />
                  <span className="min-w-0 flex-1 truncate text-left">Search</span>
                  <kbd aria-hidden="true" className="shrink-0 rounded-[4px] border border-grey-300 px-1 font-sans text-xs text-grey-700">
                    {shortcut}
                  </kbd>
                </span>
              </Button>
            </div>
          )}
          footer={(
            <div data-testid="desktop-sidebar-footer">
              <AccountMenu base={base} user={user} workspaceSlug={workspace.workspace_slug} />
            </div>
          )}
        >
          <SideNavSection title="Workspace">
            {WORKSPACE_NAV.map((item) => (
              <SidebarItem
                key={item.label}
                to={base + item.path}
                item={item}
                alsoActiveFor={item.path === '/sprints' ? [`${base}/milestones`] : undefined}
              />
            ))}
            {workspace.role === 'admin' ? <SidebarItem to={base + ADMIN_NAV.path} item={ADMIN_NAV} /> : null}
          </SideNavSection>
          <SideNavSection title="Activity">
            {ACTIVITY_NAV.map((item) => (
              <SidebarItem key={item.label} to={base + item.path} item={item} />
            ))}
          </SideNavSection>
          {/* Separated because it leaves the workspace: the work log spans
              every organisation this person belongs to. */}
          <SideNavSection title="Across organisations">
            <SidebarItem to="/me/worklog" item={{ label: 'My work log', path: '/me/worklog', icon: 'worklog' }} />
          </SideNavSection>
        </SideNav>
      </aside>

      <header className="flex items-center gap-2 border-b border-grey-200 bg-grey-100 p-2 sm:hidden">
        <div className="min-w-0 flex-1">
          <WorkspaceSwitcher memberships={memberships} workspace={workspace} />
        </div>
        <span className="ui-touch shrink-0">
        <IconButton
          label="Search"
          variant="ghost"
          size="lg"
          icon={<Icon name="search" className="size-5" />}
          onClick={() => setPaletteOpen(true)}
        />
        </span>
      </header>

      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-3 pb-24 pt-4 sm:p-4">{children}</main>

      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-grey-200 bg-paper sm:hidden"
      >
        <div className="grid grid-cols-5 gap-1 px-2 pt-1 pb-[calc(0.25rem+env(safe-area-inset-bottom))]">
          {MOBILE_NAV.map((item) => (
            <NavLink
              key={item.label}
              to={base + item.path}
              alsoActiveFor={item.path === '/sprints' ? [`${base}/milestones`] : undefined}
              className={TAB_ITEM}
              activeClassName="bg-grey-100 font-medium text-ink"
            >
              <Icon name={item.icon} className={TAB_ICON} />
              <span>{item.label}</span>
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
