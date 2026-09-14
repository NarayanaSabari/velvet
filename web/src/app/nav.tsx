import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from 'react'

export interface NavLinkProps {
  to: string
  children: ReactNode
  className?: string
  activeClassName?: string
}

function normalisePath(path: string) {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '/'
  if (withoutQuery.length <= 1) return '/'
  return withoutQuery.replace(/\/+$/, '')
}

function isNavLinkActive(to: string, pathname?: string) {
  if (to.startsWith('#') || /^https?:\/\//.test(to)) return false

  const target = normalisePath(to)
  const current = normalisePath(
    pathname ?? (typeof window === 'undefined' ? '/' : window.location.pathname),
  )

  // The workspace root should not remain selected while a deeper page is open.
  if (/^\/w\/[^/]+$/.test(target)) return current === target
  return current === target || current.startsWith(`${target}/`)
}

/**
 * The shell renders links without depending on a router being mounted, so it
 * stays testable on its own. The router provides the real implementation.
 */
const NavLinkContext = createContext<(props: NavLinkProps) => ReactNode>(
  ({ to, children, className }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
)

export const NavLinkProvider = NavLinkContext.Provider

export function NavLink(props: NavLinkProps) {
  const Impl = useContext(NavLinkContext)
  const active = isNavLinkActive(props.to)
  const className = [
    props.className,
    active ? props.activeClassName : undefined,
  ]
    .filter(Boolean)
    .join(' ')
  const element = Impl({ ...props, className })

  if (!isValidElement(element)) return <>{element}</>

  return cloneElement(
    element as ReactElement<{ 'aria-current'?: 'page'; 'data-active'?: string }>,
    {
      'aria-current': active ? 'page' : undefined,
      'data-active': active ? 'true' : undefined,
    },
  )
}
