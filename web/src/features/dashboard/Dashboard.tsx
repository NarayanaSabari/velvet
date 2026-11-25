import { FormDialog } from '../../ui/FormDialog'
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Card } from '@astryxdesign/core/Card'
import { Heading } from '@astryxdesign/core/Heading'
import { List, ListItem } from '@astryxdesign/core/List'

import { api } from '../../lib/api'
import type { DashboardPayload, Issue, Milestone } from '../../lib/types'
import { EmptyState } from '../../ui/EmptyState'
import { Button } from '../../ui/Button'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { StatusBadge } from '../../ui/StatusBadge'
import { NavLink } from '../../app/nav'
import { ActivityRow } from '../activity/ActivityRow'
import { useSession } from '../auth/useSession'
import { ConnectAgentCard } from '../onboarding/ConnectAgentCard'
import { IssueForm, type IssueInput } from '../work/CoreForms'
import { useWorkLinks } from '../work/workLinks'
import { formatDay } from '../../lib/formatDate'

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <SectionHeader title={title} action={action} />
      {children}
    </section>
  )
}

// The same row as the Issues page: the whole row is one link, with the key
// in a fixed column so titles line up down the list.
function IssueLine({ slug, issue }: { slug: string; issue: Issue }) {
  return (
    <ListItem
      itemKey={issue.id}
      href={`/w/${slug}/issues/${issue.key}`}
      label={(
        <span className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-2">
          <span className="font-mono text-xs text-grey-500">{issue.key}</span>
          <span className="min-w-0 text-sm font-medium text-ink [overflow-wrap:anywhere]">{issue.title}</span>
        </span>
      )}
      endContent={<StatusBadge status={issue.status} />}
    />
  )
}

function groupByMilestone(issues: Issue[], milestones: Milestone[]) {
  const names = new Map(milestones.map((m) => [m.id, m.name]))
  const groups = new Map<string, { name: string; issues: Issue[] }>()
  for (const issue of issues) {
    const id = issue.milestone_id ?? 'none'
    const group = groups.get(id) ?? {
      // Unfiled work is deliberate in this product, so it gets a named group
      // rather than being hidden.
      name: issue.milestone_id ? (names.get(issue.milestone_id) ?? 'Milestone') : 'No milestone',
      issues: [],
    }
    group.issues.push(issue)
    groups.set(id, group)
  }
  return [...groups.entries()]
}

function MilestoneSummary({ slug, milestone }: { slug: string; milestone: Milestone }) {
  const counts = milestone.issue_counts ?? {}
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return (
    <div className="flex items-center gap-2 sm:items-start sm:py-1">
      <NavLink to={`/w/${slug}/milestones/${milestone.id}`} className="flex min-h-11 min-w-0 flex-1 items-center [overflow-wrap:anywhere] sm:block sm:min-h-0">
        {milestone.name}
      </NavLink>
      {/* "0/0" reads like nothing got done; an empty milestone says so instead. */}
      {total === 0 ? (
        <span className="shrink-0 text-grey-500">No issues yet</span>
      ) : (
        <span className="shrink-0 tabular-nums text-grey-500" aria-label={`${counts.done ?? 0} of ${total} issues done`}>
          {counts.done ?? 0}/{total}
        </span>
      )}
    </div>
  )
}

export function Dashboard({ slug }: { slug: string }) {
  const queryClient = useQueryClient()
  const { workspace } = useSession(slug)
  const canWrite = workspace?.role === 'admin' || workspace?.role === 'member'
  const [creatingIssue, setCreatingIssue] = useState(false)
  const query = useQuery({
    queryKey: ['dashboard', slug],
    queryFn: () => api.get<DashboardPayload>(`/w/${slug}/dashboard`),
  })
  const createIssue = useMutation({
    mutationFn: (input: IssueInput) => api.post<Issue>(`/w/${slug}/issues`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard', slug] }),
  })
  const links = useWorkLinks(slug)

  const header = (
    <PageHeader
      title="Dashboard"
      description="Each project's current sprint, your assigned work, and latest activity in one view."
      actions={canWrite && query.data ? (
        <Button variant="primary" onClick={() => setCreatingIssue(true)}>New issue</Button>
      ) : undefined}
    />
  )

  if (query.isPending) return <div className="w-full min-w-0">{header}<LoadingState /></div>
  if (query.error) {
    return (
      <div className="w-full min-w-0">
        {header}
        <ErrorState
          message="Could not load the dashboard."
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
      </div>
    )
  }

  const data = query.data
  // Older servers send only the first active sprint, so fall back to it.
  const activeSprints = data.active_sprints
    ?? (data.active_sprint ? [{ sprint: data.active_sprint, project_key: '', project_name: '', milestones: data.milestones }] : [])
  const groups = groupByMilestone(data.my_issues, activeSprints.flatMap((active) => active.milestones))

  return (
    <div className="w-full min-w-0">
      {header}

      <ConnectAgentCard slug={slug} />

      {canWrite && creatingIssue ? (
        <FormDialog title="New issue" description="Capture work now. Project and milestone are optional." onClose={() => setCreatingIssue(false)}>
          <IssueForm
            links={{ projects: links.projects, milestones: links.milestones }}
            onSubmit={async (input) => {
              await createIssue.mutateAsync(input)
              setCreatingIssue(false)
            }}
          />
        </FormDialog>
      ) : null}

      {data.unread_mentions > 0 ? (
        <div className="mb-6">
          <Card padding={4}>
            <NavLink to={`/w/${slug}/mentions`} className="text-sm underline">
              {data.unread_mentions} unread{' '}
              {data.unread_mentions === 1 ? 'mention' : 'mentions'}
            </NavLink>
          </Card>
        </div>
      ) : null}

      <div className="grid gap-x-8 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,30rem)]">
        <div className="min-w-0">
          {activeSprints.length === 0 ? (
            <Section title="Sprint">
              <EmptyState
                title="No active sprint"
                message="Each project runs its own sprint. Activate one from Sprints."
              />
            </Section>
          ) : (
            activeSprints.map((active) => (
              <section key={active.sprint.id} className="mb-6" data-testid="dashboard-active-sprint">
                <SectionHeader
                  title={(
                    <NavLink to={`/w/${slug}/sprints/${active.sprint.id}`}>
                      {active.project_name ? `${active.project_name} · ` : 'Sprint '}
                      {active.sprint.name}
                    </NavLink>
                  )}
                  meta={`ends ${formatDay(active.sprint.ends_on)}`}
                />
                {active.milestones.length === 0 ? (
                  <EmptyState title="No milestones in this sprint" />
                ) : (
                  <div className="divide-y divide-grey-200 border-y border-grey-200">
                    {active.milestones.map((m) => (
                      <MilestoneSummary key={m.id} slug={slug} milestone={m} />
                    ))}
                  </div>
                )}
              </section>
            ))
          )}

          <Section title="My open issues">
            {groups.length === 0 ? (
              <EmptyState title="Nothing assigned to you" message="Enjoy the quiet." />
            ) : (
              groups.map(([id, group]) => (
                <div key={id} className="border-b border-grey-200" data-testid="dashboard-issue-group">
                  <List
                    hasDividers
                    density="balanced"
                    edge="flush"
                    header={(
                      <div className="px-2 pt-4 pb-2">
                        <Heading level={3}>{group.name}</Heading>
                      </div>
                    )}
                  >
                    {group.issues.map((issue) => (
                      <IssueLine key={issue.id} slug={slug} issue={issue} />
                    ))}
                  </List>
                </div>
              ))
            )}
          </Section>
        </div>

        <div className="min-w-0">
          <Section
            title="My recent activity"
            action={(
              <NavLink to={`/w/${slug}/feed`} className="text-grey-500 underline hover:text-ink">
                See team feed
              </NavLink>
            )}
          >
            {data.activity.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              // These rows are not links themselves: each one carries its
              // own links to the issue, milestone or pull request it names.
              <div className="border-b border-grey-200">
                <List hasDividers density="balanced" edge="flush" aria-label="My recent activity">
                  {data.activity.map((a) => (
                    <ListItem
                      key={a.id}
                      itemKey={a.id}
                      label={<ActivityRow activity={a} slug={slug} hideActor />}
                    />
                  ))}
                </List>
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
