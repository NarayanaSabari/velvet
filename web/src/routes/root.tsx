import { Outlet, useParams, useRouterState, Link } from '@tanstack/react-router'

import { Shell } from '../app/Shell'
import { NavLinkProvider, type NavLinkProps } from '../app/nav'

function RouterNavLink({ to, children, className }: NavLinkProps) {
  return (
    <Link to={to} className={className}>
      {children}
    </Link>
  )
}

export function RootLayout() {
  const params = useParams({ strict: false }) as { slug?: string }
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const isPublicAuthRoute = pathname === '/signin' || pathname === '/not-invited'

  return (
    <NavLinkProvider value={RouterNavLink}>
      {isPublicAuthRoute ? (
        <Outlet />
      ) : (
        <Shell slug={params.slug}>
          <Outlet />
        </Shell>
      )}
    </NavLinkProvider>
  )
}

/** Placeholder until the feature tasks land their real pages. */
export function Placeholder({ title }: { title: string }) {
  return <h1 className="text-lg">{title}</h1>
}
