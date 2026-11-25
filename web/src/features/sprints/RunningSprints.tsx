import { Badge } from '@astryxdesign/core/Badge'
import { Card } from '@astryxdesign/core/Card'
import { Heading } from '@astryxdesign/core/Heading'
import { Link } from '@astryxdesign/core/Link'
import { List, ListItem } from '@astryxdesign/core/List'
import { ProgressBar } from '@astryxdesign/core/ProgressBar'
import { Text } from '@astryxdesign/core/Text'
import { useQuery } from '@tanstack/react-query'

import { api, listAllWorkspaceIssues } from '../../lib/api'
import { formatDay } from '../../lib/formatDate'
import type { DashboardPayload, Issue, Milestone, Project, Sprint } from '../../lib/types'
import { SectionHeader } from '../../ui/PageHeader'
import { issueWork, issuesInSprint, milestoneWork, sprintPace } from './sprintDays'

function milestoneCounts(milestone: Milestone) {
  const counts = milestone.issue_counts ?? {}
  const total = Object.values(counts).reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0)
  return { done: counts.done ?? 0, total }
}

export interface RunningGroup {
  project: Project | undefined
  id: string
  sprints: Sprint[]
}

/**
 * What each project is working on now, under the calendar: its running
 * sprint, how far through its dates it is, and how its milestones stand.
 * The calendar shows when; this shows how it is going.
 */
export function RunningSprints({ slug, groups }: { slug: string; groups: RunningGroup[] }) {
  // The dashboard already gathers each running sprint's milestones. If it
  // cannot be read the cards still show the sprint and its dates.
  const dashboard = useQuery({
    queryKey: ['dashboard', slug],
    queryFn: () => api.get<DashboardPayload>(`/w/${slug}/dashboard`),
  })
  // Every issue, to count each sprint's work including issues that have no
  // milestone yet. The sprint's own page reads the same list, so it is shared.
  const issues = useQuery({
    queryKey: ['issues', slug, { milestone_id: null }],
    queryFn: async () => ({ issues: await listAllWorkspaceIssues<Issue>(slug) }),
  })
  const milestonesBySprint = new Map(
    (dashboard.data?.active_sprints ?? []).map((active) => [active.sprint.id, active.milestones]),
  )

  return (
    <section aria-labelledby="running-sprints-heading" data-testid="running-sprints">
      <SectionHeader id="running-sprints-heading" title="Running now" />
      <ul className="mt-3 grid gap-4 lg:grid-cols-2 xl:grid-cols-3" aria-label="Running sprints">
        {groups.map((group) => {
          const name = group.project?.name ?? 'Project'
          const active = group.sprints.find((sprint) => sprint.state === 'active')
          const next = group.sprints
            .filter((sprint) => sprint.state === 'upcoming')
            .sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0]
          const milestones = active ? milestonesBySprint.get(active.id) : undefined
          // With the issue list this is every issue in the sprint. Without
          // it, the milestones' own counts are the best available.
          const pace = active
            ? sprintPace(active, issues.data && milestones
              ? issueWork(issuesInSprint(active, milestones, issues.data.issues))
              : milestoneWork(milestones ?? []))
            : null
          const progress = pace
          const work = { done: pace?.done ?? 0, total: pace?.total ?? 0 }
          const behind = pace?.behind ?? false
          return (
            <li key={group.id} className="min-w-0" data-testid={`running-sprint-${group.project?.key ?? group.id}`}>
              <Card padding={5} height="100%">
                <div className="flex h-full flex-col gap-3">
                  <Text type="supporting" color="secondary">{name}</Text>
                  {active && progress ? (
                    <>
                      <div>
                        <div className="flex items-baseline justify-between gap-3">
                          <Heading level={3}>
                            <Link href={`/w/${slug}/sprints/${active.id}`} color="primary" type="inherit" hasUnderline>{active.name}</Link>
                          </Heading>
                          {behind ? <Badge variant="warning" label="Behind" /> : null}
                        </div>
                        <Text as="p" color="secondary" display="block" className="mt-1">
                          {formatDay(active.starts_on)} – {formatDay(active.ends_on)}
                        </Text>
                      </div>
                      <div>
                        <ProgressBar label={`${active.name}: day ${progress.day} of ${progress.length}`} isLabelHidden value={progress.day} max={progress.length} />
                        <Text as="p" type="supporting" color="secondary" display="block" className="mt-2">
                          Day {progress.day} of {progress.length} · {progress.left === 0 ? 'ends today' : `${progress.left} ${progress.left === 1 ? 'day' : 'days'} left`}
                        </Text>
                        {/* The numbers behind the badge, in words, so it is never colour alone. */}
                        {work.total > 0 ? (
                          <p className={`mt-1 text-sm ${behind ? 'text-stale' : 'text-grey-500'}`} data-testid="sprint-pace">
                            {work.done} of {work.total} {work.total === 1 ? 'issue' : 'issues'} done
                            {behind ? `, with ${progress.timeGone}% of the time gone` : ''}
                          </p>
                        ) : null}
                      </div>
                      {milestones && milestones.length > 0 ? (
                        <div className="border-t border-grey-200">
                          <List hasDividers density="compact" edge="flush" aria-label={`${active.name} milestones`}>
                            {milestones.map((milestone) => {
                              const { done, total } = milestoneCounts(milestone)
                              return (
                                <ListItem
                                  key={milestone.id}
                                  itemKey={milestone.id}
                                  href={`/w/${slug}/milestones/${milestone.id}`}
                                  label={milestone.name}
                                  // "0/0" reads like nothing got done. A milestone
                                  // nobody has filed work under yet says that instead.
                                  endContent={total === 0 ? (
                                    <Text type="supporting" color="secondary">No issues yet</Text>
                                  ) : (
                                    <Text type="supporting" color="secondary" className="tabular-nums" aria-label={`${done} of ${total} issues done`}>
                                      {done}/{total}
                                    </Text>
                                  )}
                                />
                              )
                            })}
                          </List>
                        </div>
                      ) : milestones ? (
                        <Text type="supporting" color="secondary">No milestones in this sprint yet.</Text>
                      ) : null}
                    </>
                  ) : (
                    <div>
                      <Heading level={3}>No sprint running</Heading>
                      <Text as="p" color="secondary" display="block" className="mt-1">
                        {next ? `${next.name} starts ${formatDay(next.starts_on)}.` : 'Nothing is planned next.'}
                      </Text>
                    </div>
                  )}
                  {active && next ? (
                    <Text as="p" type="supporting" color="secondary" display="block" className="mt-auto">
                      Next: {next.name}, from {formatDay(next.starts_on)}
                    </Text>
                  ) : null}
                </div>
              </Card>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
