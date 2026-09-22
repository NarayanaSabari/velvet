import { Outlet, useNavigate, useParams, useRouterState, Link } from '@tanstack/react-router'

import { Shell } from '../app/Shell'
import { NavLinkProvider, type NavLinkProps } from '../app/nav'
import { PublicAuthPage } from '../features/auth/PublicAuthPage'
import { buttonClassName } from '../ui/buttonStyles'

function RouterNavLink({ to, children, className }: NavLinkProps) {
  return (
    <Link to={to} className={className}>
      {children}
    </Link>
  )
}

function isProductPath(pathname: string) {
  return pathname === '/w' || pathname.startsWith('/w/')
    || pathname === '/me/worklog' || pathname.startsWith('/me/worklog/')
}

export function RootNotFound() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // Keep the existing product not-found content inside its workspace shell.
  if (isProductPath(pathname)) return <p>Not Found</p>

  return (
    <PublicAuthPage title="Page not found" note="">
      <div className="space-y-4">
        <p className="text-sm text-grey-700">This page does not exist or the link is no longer available.</p>
        <div className="flex flex-wrap gap-2">
          <Link to="/" className={buttonClassName('primary', 'inline-flex min-h-11 items-center')}>Go home</Link>
          <Link to="/signin" className={buttonClassName('secondary', 'inline-flex min-h-11 items-center')}>Sign in</Link>
        </div>
      </div>
    </PublicAuthPage>
  )
}

export function RootLayout() {
  const params = useParams({ strict: false }) as { slug?: string }
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const navigate = useNavigate()
  const outsideShell = !isProductPath(pathname)

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
