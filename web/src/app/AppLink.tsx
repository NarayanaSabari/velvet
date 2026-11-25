import type { MouseEventHandler, ReactNode } from 'react'

import { NavLink } from './nav'

/**
 * The link Astryx's components render, set once in main.tsx. A path inside
 * the app goes through Velvet's own link, so it navigates in the router
 * without a full page load. Anything else is a plain anchor.
 */
export function AppLink({ href, to, children, className, onClick, ...attributes }: {
  href?: string
  to?: string
  children?: ReactNode
  className?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
  [attribute: string]: unknown
}) {
  const destination = to ?? href ?? '#'
  if (!destination.startsWith('/') || destination.startsWith('/api/')) {
    return <a {...attributes} href={destination} className={className} onClick={onClick}>{children}</a>
  }
  return (
    // These links are rows and buttons, not navigation, so none is "current".
    <NavLink to={destination} className={className} onClick={onClick} current={false} attributes={attributes}>
      {children}
    </NavLink>
  )
}
