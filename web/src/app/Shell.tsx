import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

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
        className="flex w-full items-center gap-2 rounded-[6px] px-1 py-1.5 text-left text-sm hover:bg-grey-100 focus-visible:bg-grey-100"
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
        <Avatar user={user} size="md" />
        <span className="min-w-0 flex-1 truncate text-grey-700">{label}</span>
        <span aria-hidden="true" className="text-grey-500">
          {open ? '−' : '+'}
        </span>
      </button>

      <div
        ref={menuRef}
        id="account-menu"
        role={leaveConfirming ? 'alertdialog' : 'menu'}
        aria-label={leaveConfirming ? `Leave ${workspaceSlug}` : undefined}
        aria-hidden={!open}
        inert={!open}
        onKeyDown={leaveConfirming ? undefined : onMenuKeyDown}
        className={`absolute bottom-[calc(100%+0.5rem)] left-0 z-40 w-52 origin-bottom-left rounded-[8px] border border-grey-200 bg-paper p-1 ${
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
        className={TAB_ITEM}
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
        <span aria-hidden="true" className="text-base leading-none">
          {open ? '−' : '+'}
        </span>
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
        className={`absolute bottom-[calc(100%+0.5rem)] right-0 z-40 w-56 origin-bottom-right rounded-[8px] border border-grey-200 bg-paper p-1 ${
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
        className="sr-only z-50 rounded-[6px] border border-ink bg-paper px-3 py-2 text-sm focus:fixed focus:top-2 focus:left-2 focus:not-sr-only"
      >
        Skip to content
      </a>
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
