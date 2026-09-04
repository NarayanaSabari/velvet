import { createContext, useContext, type ReactNode } from 'react'

export interface NavLinkProps {
  to: string
  children: ReactNode
  className?: string
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
  return <>{Impl(props)}</>
}
