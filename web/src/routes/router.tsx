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
import { Dashboard } from '../features/dashboard/Dashboard'
import { TeamFeed } from '../features/feed/TeamFeed'
import { SprintList } from '../features/sprints/SprintList'
import { SprintBoard } from '../features/sprints/SprintBoard'
import { MilestonePage } from '../features/milestones/MilestonePage'
import { IssuePage } from '../features/issues/IssuePage'

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

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug',
  component: function DashboardRoute() {
    const { slug } = dashboardRoute.useParams()
    return <Dashboard slug={slug} />
  },
})

const feedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/feed',
  component: function FeedRoute() {
    const { slug } = feedRoute.useParams()
    return <TeamFeed slug={slug} />
  },
})

const sprintsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/sprints',
  component: function SprintsRoute() {
    const { slug } = sprintsRoute.useParams()
    return <SprintList slug={slug} />
  },
})

const sprintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/sprints/$sprintId',
  component: function SprintRoute() {
    const { slug, sprintId } = sprintRoute.useParams()
    return <SprintBoard slug={slug} sprintId={sprintId} />
  },
})

const milestoneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/milestones/$milestoneId',
  component: function MilestoneRoute() {
    const { slug, milestoneId } = milestoneRoute.useParams()
    return <MilestonePage slug={slug} milestoneId={milestoneId} />
  },
})

const issueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/issues/$issueKey',
  component: function IssueRoute() {
    const { slug, issueKey } = issueRoute.useParams()
    return <IssuePage slug={slug} issueKey={issueKey} />
  },
})

const routes = [
  indexRoute,
  dashboardRoute,
  feedRoute,
  sprintsRoute,
  sprintRoute,
  milestoneRoute,
  issueRoute,
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
