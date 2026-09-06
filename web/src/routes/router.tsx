import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
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
import { UnlinkedPRs } from '../features/evidence/UnlinkedPRs'
import { Reports } from '../features/reports/Reports'
import { Admin } from '../features/admin/Admin'
import { Mentions } from '../features/mentions/Mentions'

const rootRoute = createRootRoute({ component: RootLayout })

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

const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/reports',
  component: function ReportsRoute() {
    const { slug } = reportsRoute.useParams()
    return <Reports slug={slug} />
  },
})

const unlinkedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/unlinked',
  component: function UnlinkedRoute() {
    const { slug } = unlinkedRoute.useParams()
    return <UnlinkedPRs slug={slug} />
  },
})

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/admin',
  component: function AdminRoute() {
    const { slug } = adminRoute.useParams()
    return <Admin slug={slug} />
  },
})

const mentionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/mentions',
  component: function MentionsRoute() {
    const { slug } = mentionsRoute.useParams()
    return <Mentions slug={slug} />
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
  unlinkedRoute,
  mentionsRoute,
  adminRoute,
  reportsRoute,
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

const routeTree = rootRoute.addChildren(routes)

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history })
}

export const router = createAppRouter()

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
