import { Outlet, useNavigate, useParams, useRouterState, Link } from '@tanstack/react-router'

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
  const navigate = useNavigate()
  const outsideShell = ['/', '/signin', '/signin/confirm', '/check-email', '/expired', '/invite', '/orgs/new'].includes(pathname)

  return (
    <NavLinkProvider value={RouterNavLink}>
      {outsideShell ? (
        <Outlet />
      ) : (
        <Shell slug={params.slug} navigate={(to) => void navigate({ href: to })}>
          <Outlet />
        </Shell>
      )}
    </NavLinkProvider>
  )
}
