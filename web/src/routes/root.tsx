import { useEffect } from 'react'
import { Outlet, useNavigate, useParams, useRouterState, Link } from '@tanstack/react-router'
import { Button as LinkButton } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'

import { Shell } from '../app/Shell'
import { NavLinkProvider, type NavLinkProps } from '../app/nav'
import { PublicAuthPage } from '../features/auth/PublicAuthPage'
import { NotFoundState } from '../ui/QueryState'
import { productPageTitle } from './productTitle'

function RouterNavLink({ to, children, className, activeClassName: _activeClassName, attributes, ...linkProps }: NavLinkProps) {
  // NavLink owns the active state, including a section staying current on its
  // nested pages. The router spreads its own aria-current last, so it is only
  // allowed to match exactly: a prefix match marked the dashboard current on
  // every nested route, and NavLink's aria-current is then applied on top.
  return (
    <Link {...attributes} to={to} className={className} activeOptions={{ exact: true }} {...linkProps}>
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
  if (isProductPath(pathname)) {
    const slug = /^\/w\/([^/]+)/.exec(pathname)?.[1]
    return (
      <NotFoundState
        title="Page not found"
        message="This page does not exist or the link is no longer available."
        backTo={slug ? `/w/${slug}` : '/'}
        backLabel={slug ? 'Back to the dashboard' : 'Back to your organisations'}
      />
    )
  }

  return (
    <PublicAuthPage title="Page not found">
      <div className="space-y-4">
        <Text as="p" color="secondary" display="block">This page does not exist or the link is no longer available.</Text>
        <div className="flex flex-wrap gap-2">
          <LinkButton variant="primary" href="/" label="Go home" />
          <LinkButton href="/signin" label="Sign in" />
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

  useEffect(() => {
    if (!outsideShell) document.title = `${productPageTitle(pathname)} · Velvet`
  }, [outsideShell, pathname])

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
