import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type AriaRole,
  type ReactElement,
  type MouseEventHandler,
  type ReactNode,
} from 'react'

import { isNavLinkActive } from './navActive'

export interface NavLinkProps {
  to: string
  children: ReactNode
  className?: string
  activeClassName?: string
  role?: AriaRole
  tabIndex?: number
  onClick?: MouseEventHandler<HTMLAnchorElement>
  /** Extra path prefixes that also mark this link current. */
  alsoActiveFor?: string[]
  /** Set by a caller that has already decided whether this link is current. */
  current?: boolean
  /** Extra attributes for the anchor, such as the data attributes a
   *  component library styles its links by. */
  attributes?: Record<string, unknown>
}

/**
 * The shell renders links without depending on a router being mounted, so it
 * stays testable on its own. The router provides the real implementation.
 */
const NavLinkContext = createContext<(props: NavLinkProps) => ReactNode>(
  ({ to, children, className, role, tabIndex, onClick, attributes }: NavLinkProps) => (
    <a {...attributes} href={to} className={className} role={role} tabIndex={tabIndex} onClick={onClick}>
      {children}
    </a>
  ),
)

export const NavLinkProvider = NavLinkContext.Provider

export function NavLink(props: NavLinkProps) {
  const Impl = useContext(NavLinkContext)
  const { alsoActiveFor = [], current, ...linkProps } = props
  const active = current ?? [props.to, ...alsoActiveFor].some((to) => isNavLinkActive(to))
  const className = [
    props.className,
    active ? props.activeClassName : undefined,
  ]
    .filter(Boolean)
    .join(' ')
  const element = Impl({ ...linkProps, className })

  if (!isValidElement(element)) return <>{element}</>

  return cloneElement(
    element as ReactElement<{ 'aria-current'?: 'page'; 'data-active'?: string }>,
    {
      'aria-current': active ? 'page' : undefined,
      'data-active': active ? 'true' : undefined,
    },
  )
}
