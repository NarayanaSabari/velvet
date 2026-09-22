import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router'

import type { QueryClient } from '@tanstack/react-query'
import { queryClient } from '../lib/query'
import { SignIn } from '../features/auth/SignIn'
import { ConfirmSignIn } from '../features/auth/ConfirmSignIn'
import { CheckEmail } from '../features/auth/CheckEmail'
import { Expired } from '../features/auth/Expired'
import { Invite } from '../features/auth/Invite'
import { landingWorkspace, sessionQueryOptions } from '../features/auth/useSession'
import { NewOrganisation } from '../features/orgs/NewOrganisation'
import { ProfileRoute } from '../features/profile/Profile'
import { LandingPage } from '../features/landing/LandingPage'
import { RootLayout } from './root'
import { Dashboard } from '../features/dashboard/Dashboard'
import { TeamFeed } from '../features/feed/TeamFeed'
import { SprintList } from '../features/sprints/SprintList'
import { SprintBoard } from '../features/sprints/SprintBoard'
import { MilestonePage } from '../features/milestones/MilestonePage'
import { IssuesPage } from '../features/issues/IssuesPage'
import { ProjectsPage } from '../features/projects/ProjectsPage'
import { Recap } from '../features/recap/Recap'
import { IssuePage } from '../features/issues/IssuePage'
import { UnlinkedPRs } from '../features/evidence/UnlinkedPRs'
import { Reports } from '../features/reports/Reports'
import { Admin } from '../features/admin/Admin'
import { Mentions } from '../features/mentions/Mentions'

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: RootLayout })

// Signed-in callers should get back to work immediately. Signed-out callers
// stay at the public root so they can understand the product before signing in.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery({ ...sessionQueryOptions(context.queryClient), staleTime: 0 })
    if (!session) return
    const workspace = landingWorkspace(session)
    // `href` rather than a typed `to`: the route tree is still being built
    // here, so its literal paths are not yet known to the type checker.
    throw redirect({ href: workspace ? `/w/${workspace.workspace_slug}` : '/orgs/new' })
  },
  component: LandingPage,
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

const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/issues',
  component: function IssuesRoute() {
    const { slug } = issuesRoute.useParams()
    return <IssuesPage slug={slug} />
  },
})

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug/projects',
  component: function ProjectsRoute() {
    const { slug } = projectsRoute.useParams()
    return <ProjectsPage slug={slug} />
  },
})

// Outside /w/$slug on purpose: the work log spans every organisation, so
// scoping it to one would answer a smaller question than the one people ask.
const recapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me/worklog',
  component: Recap,
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
  issuesRoute,
  issueRoute,
  projectsRoute,
  recapRoute,
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
    path: '/signin/confirm',
    component: ConfirmSignIn,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/check-email',
    component: CheckEmail,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/expired',
    component: Expired,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/invite',
    component: Invite,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/orgs/new',
    component: NewOrganisation,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$slug/settings/profile',
    component: ProfileRoute,
  }),
]

const routeTree = rootRoute.addChildren(routes)

export function createAppRouter(history?: RouterHistory, client = queryClient) {
  return createRouter({ routeTree, history, context: { queryClient: client } })
}

export const router = createAppRouter()

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
