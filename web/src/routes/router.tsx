import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'

import { api } from '../lib/api'
import type { SessionPayload } from '../lib/types'
import { SignIn } from '../features/auth/SignIn'
import { NotInvited } from '../features/auth/NotInvited'
import { Placeholder, RootLayout } from './root'

const rootRoute = createRootRoute({ component: RootLayout })

function page(path: string, title: string) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <Placeholder title={title} />,
  })
}

// `/` cannot know the workspace slug on its own, so it asks the session which
// workspace the caller actually belongs to before redirecting.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async () => {
    const session = await api.get<SessionPayload>('/me').catch(() => null)
    const first = session?.memberships[0]
    // `href` rather than a typed `to`: the route tree is still being built
    // here, so its literal paths are not yet known to the type checker.
    if (first) throw redirect({ href: `/w/${first.workspace_slug}` })
  },
  component: () => <Placeholder title="Work log" />,
})

const routes = [
  indexRoute,
  page('/w/$slug', 'Dashboard'),
  page('/w/$slug/feed', 'Team feed'),
  page('/w/$slug/sprints', 'Sprints'),
  page('/w/$slug/sprints/$sprintId', 'Sprint'),
  page('/w/$slug/milestones/$milestoneId', 'Milestone'),
  page('/w/$slug/issues/$issueKey', 'Issue'),
  page('/w/$slug/unlinked', 'Unlinked PRs'),
  page('/w/$slug/reports', 'Reports'),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/signin',
    component: () => <SignIn />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/not-invited',
    component: () => <NotInvited />,
  }),
]

export const router = createRouter({ routeTree: rootRoute.addChildren(routes) })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
