import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import { useSession } from '../features/auth/useSession'
import { SignIn } from '../features/auth/SignIn'
import { NewOrganisation } from '../features/orgs/NewOrganisation'
import { LeaveOrganisation } from '../features/orgs/LeaveOrganisation'
import { SignOutButton } from '../features/auth/SignOutButton'
import { CommandPalette } from '../features/palette/CommandPalette'
import { COMMAND_PALETTE_TEST_IDS } from '../features/palette/paletteTestIds'
import { Avatar } from '../ui/Avatar'
import { Icon, type IconName } from '../ui/Icon'
import { LoadingState } from '../ui/QueryState'
import { userLabel } from '../lib/userLabel'
import type { Membership, Role } from '../lib/types'
import { NavLink } from './nav'

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
const NAV_ITEM =
  `group flex min-h-8 items-center gap-2.5 rounded-[var(--radius-control)] border border-transparent px-2 py-1 text-sm text-ink ${SIDEBAR_HOVER}`
const NAV_ACTIVE =
  'border-grey-200 bg-paper font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] hover:bg-paper focus-visible:bg-paper'
const NAV_ICON = 'size-4 shrink-0 text-grey-500 group-hover:text-ink group-aria-[current=page]:text-ink'
const MENU_ITEM =
  'block rounded-[var(--radius-control)] px-2 py-1.5 text-sm hover:bg-grey-100 focus-visible:bg-grey-100'
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

  // The native select stays the real control, stretched invisibly over the
  // identity row, so keyboard, screen reader, and mobile pickers all behave
  // natively while the row carries the visible design and focus ring.
  return (
    <label
      className={`relative flex min-w-0 cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] p-1 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-ink ${SIDEBAR_HOVER}`}
    >
      {identity}
      <Icon name="selector" className="size-4 shrink-0 text-grey-500" />
      <select
        aria-label="Organisation"
        className="absolute inset-0 w-full cursor-pointer text-sm opacity-0"
        value={workspace.workspace_slug}
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

function SidebarLink({ to, item }: { to: string; item: NavItem }) {
  return (
    <NavLink to={to} className={NAV_ITEM} activeClassName={NAV_ACTIVE}>
      <Icon name={item.icon} className={NAV_ICON} />
      <span className="min-w-0 truncate">{item.label}</span>
    </NavLink>
  )
}

function SidebarSection({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: ReactNode
}) {
  return (
    <div className="pt-4 first:pt-0">
      <p id={id} className="px-2 pb-1 text-xs font-medium text-grey-700">
        {label}
      </p>
      <ul aria-labelledby={id} className="space-y-0.5">
        {children}
      </ul>
    </div>
  )
}

function MenuLink({ to, children, onSelect }: { to: string; children: ReactNode; onSelect: () => void }) {
  return (
    <NavLink
      to={to}
      role="menuitem"
      tabIndex={-1}
      onClick={onSelect}
      className={MENU_ITEM}
      activeClassName="bg-grey-100 font-medium"
    >
      {children}
    </NavLink>
  )
}

function usePopupMenu(
  open: boolean,
  setOpen: (open: boolean) => void,
  setConfirming: (confirming: boolean) => void,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()

    function closeAndReturnFocus() {
      setConfirming(false)
      setOpen(false)
      triggerRef.current?.focus()
    }
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setConfirming(false)
        setOpen(false)
      }
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeAndReturnFocus()
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, setConfirming, setOpen])

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length
    if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = items.length - 1
    if (event.key === 'Tab') {
      setConfirming(false)
      setOpen(false)
    }
    if (next !== null) {
      event.preventDefault()
      items[next]?.focus()
    }
  }

  return { containerRef, triggerRef, menuRef, onMenuKeyDown }
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
  const [leaveConfirming, setLeaveConfirming] = useState(false)
  const label = userLabel(user)
  const { containerRef, triggerRef, menuRef, onMenuKeyDown } = usePopupMenu(open, setOpen, setLeaveConfirming)

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`flex w-full items-center gap-2.5 rounded-[var(--radius-control)] p-1 text-left ${SIDEBAR_HOVER}`}
        aria-label="Open account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls="account-menu"
        onClick={(event) => {
          setOpenedByKeyboard(event.detail === 0)
          if (open) setLeaveConfirming(false)
          setOpen((isOpen) => !isOpen)
        }}
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

      <div
        ref={menuRef}
        id="account-menu"
        role={leaveConfirming ? 'alertdialog' : 'menu'}
        aria-label={leaveConfirming ? `Leave ${workspaceSlug}` : undefined}
        aria-hidden={!open}
        inert={!open}
        onKeyDown={leaveConfirming ? undefined : onMenuKeyDown}
        className={`absolute bottom-[calc(100%+0.5rem)] left-0 z-40 w-full min-w-52 origin-bottom-left rounded-[var(--radius-surface)] border border-grey-200 bg-paper p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)] ${
          openedByKeyboard ? 'transition-none' : 'shell-popup-menu transition-[opacity,transform] duration-[150ms] ease-[var(--ease-out)]'
        } ${
          open
            ? 'pointer-events-auto visible scale-100 opacity-100'
            : 'pointer-events-none invisible scale-[0.97] opacity-0'
        }`}
      >
        {!leaveConfirming ? <MenuLink to={`${base}/settings/profile`} onSelect={() => setOpen(false)}>Profile</MenuLink> : null}
        {!leaveConfirming ? <MenuLink to="/orgs/new" onSelect={() => setOpen(false)}>New organisation</MenuLink> : null}
        <LeaveOrganisation
          key="leave-organisation"
          slug={workspaceSlug}
          menuItem
          confirming={leaveConfirming}
          onConfirmingChange={setLeaveConfirming}
        />
        {!leaveConfirming ? <SignOutButton menuItem /> : null}
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
  const [leaveConfirming, setLeaveConfirming] = useState(false)
  const { containerRef, triggerRef, menuRef, onMenuKeyDown } = usePopupMenu(open, setOpen, setLeaveConfirming)

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`${TAB_ITEM} aria-expanded:bg-grey-100 aria-expanded:text-ink`}
        aria-label="More"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls="mobile-more-menu"
        onClick={(event) => {
          setOpenedByKeyboard(event.detail === 0)
          if (open) setLeaveConfirming(false)
          setOpen((isOpen) => !isOpen)
        }}
      >
        <Icon name="more" className={TAB_ICON} />
        <span>More</span>
      </button>

      <div
        ref={menuRef}
        id="mobile-more-menu"
        role={leaveConfirming ? 'alertdialog' : 'menu'}
        aria-label={leaveConfirming ? `Leave ${workspaceSlug}` : undefined}
        aria-hidden={!open}
        inert={!open}
        onKeyDown={leaveConfirming ? undefined : onMenuKeyDown}
        className={`absolute bottom-[calc(100%+0.5rem)] right-0 z-40 w-56 origin-bottom-right rounded-[var(--radius-surface)] border border-grey-200 bg-paper p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)] ${
          openedByKeyboard ? 'transition-none' : 'shell-popup-menu transition-[opacity,transform] duration-[150ms] ease-[var(--ease-out)]'
        } ${
          open
            ? 'pointer-events-auto visible scale-100 opacity-100'
            : 'pointer-events-none invisible scale-[0.97] opacity-0'
        }`}
      >
        {!leaveConfirming ? <MenuLink to={`${base}/feed`} onSelect={() => setOpen(false)}>Team feed</MenuLink> : null}
        {!leaveConfirming ? <MenuLink to={`${base}/projects`} onSelect={() => setOpen(false)}>Projects</MenuLink> : null}
        {!leaveConfirming ? <MenuLink to={`${base}/unlinked`} onSelect={() => setOpen(false)}>Unlinked PRs</MenuLink> : null}
        {!leaveConfirming ? <MenuLink to={`${base}/reports`} onSelect={() => setOpen(false)}>Reports</MenuLink> : null}
        {!leaveConfirming && isAdmin ? <MenuLink to={`${base}/admin`} onSelect={() => setOpen(false)}>Administration</MenuLink> : null}
        {!leaveConfirming ? <div role="separator" className="my-1 border-t border-grey-200" /> : null}
        {/* Outside the workspace: the work log spans every organisation. */}
        {!leaveConfirming ? <MenuLink to="/me/worklog" onSelect={() => setOpen(false)}>My work log</MenuLink> : null}
        {!leaveConfirming ? <MenuLink to={`${base}/settings/profile`} onSelect={() => setOpen(false)}>Profile</MenuLink> : null}
        {!leaveConfirming ? <MenuLink to="/orgs/new" onSelect={() => setOpen(false)}>New organisation</MenuLink> : null}
        <LeaveOrganisation
          key="leave-organisation"
          slug={workspaceSlug}
          menuItem
          confirming={leaveConfirming}
          onConfirmingChange={setLeaveConfirming}
        />
        {!leaveConfirming ? <SignOutButton menuItem /> : null}
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
        className="sr-only z-50 rounded-[var(--radius-control)] border border-ink bg-paper px-3 py-2 text-sm focus:fixed focus:top-2 focus:left-2 focus:not-sr-only"
      >
        Skip to content
      </a>
      <aside
        className="hidden w-full shrink-0 border-b border-grey-200 bg-grey-100 p-3 sm:sticky sm:top-0 sm:flex sm:h-screen sm:max-h-screen sm:w-52 sm:flex-col sm:overflow-hidden sm:border-r sm:border-b-0 xl:w-60"
        data-testid="desktop-sidebar"
      >
        <div className="mb-4 shrink-0 space-y-3" data-testid="desktop-sidebar-header">
          <WorkspaceSwitcher memberships={memberships} workspace={workspace} />
          <button
            type="button"
            data-testid={COMMAND_PALETTE_TEST_IDS.trigger}
            aria-keyshortcuts="Meta+K Control+K"
            className="flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-control)] border border-grey-200 bg-paper px-2 text-left text-sm text-grey-700 hover:border-grey-300 hover:text-ink"
            onClick={() => setPaletteOpen(true)}
          >
            <Icon name="search" className="size-4 shrink-0 text-grey-500" />
            <span className="min-w-0 flex-1 truncate">Search</span>
            <kbd aria-hidden="true" className="shrink-0 rounded-[4px] border border-grey-200 px-1 font-sans text-xs text-grey-700">
              {shortcut}
            </kbd>
          </button>
        </div>

        <nav
          aria-label="Workspace navigation"
          className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-0.5"
          data-testid="desktop-sidebar-nav"
        >
          <SidebarSection id="sidebar-workspace" label="Workspace">
            {WORKSPACE_NAV.map((item) => (
              <li key={item.label}>
                <SidebarLink to={base + item.path} item={item} />
              </li>
            ))}
            {workspace.role === 'admin' ? (
              <li>
                <SidebarLink to={base + ADMIN_NAV.path} item={ADMIN_NAV} />
              </li>
            ) : null}
          </SidebarSection>
          <SidebarSection id="sidebar-activity" label="Activity">
            {ACTIVITY_NAV.map((item) => (
              <li key={item.label}>
                <SidebarLink to={base + item.path} item={item} />
              </li>
            ))}
          </SidebarSection>
          {/* Separated because it leaves the workspace: the work log spans
              every organisation this person belongs to. */}
          <SidebarSection id="sidebar-personal" label="Across organisations">
            <li>
              <SidebarLink to="/me/worklog" item={{ label: 'My work log', path: '/me/worklog', icon: 'worklog' }} />
            </li>
          </SidebarSection>
        </nav>

        <div className="mt-auto shrink-0 border-t border-grey-200 pt-3" data-testid="desktop-sidebar-footer">
          <AccountMenu
            base={base}
            user={user}
            workspaceSlug={workspace.workspace_slug}
          />
        </div>
      </aside>

      <header className="flex items-center gap-2 border-b border-grey-200 bg-grey-100 p-2 sm:hidden">
        <div className="min-w-0 flex-1">
          <WorkspaceSwitcher memberships={memberships} workspace={workspace} />
        </div>
        <button
          type="button"
          aria-label="Search"
          aria-keyshortcuts="Meta+K Control+K"
          className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-grey-700 hover:bg-grey-200/60 hover:text-ink"
          onClick={() => setPaletteOpen(true)}
        >
          <Icon name="search" className="size-5" />
        </button>
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
