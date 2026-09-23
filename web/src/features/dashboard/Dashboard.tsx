import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { DashboardPayload, Issue, Milestone } from '../../lib/types'
import { useStream } from '../../lib/useStream'
import { EmptyState } from '../../ui/EmptyState'
import { Button } from '../../ui/Button'
import { PageHeader, SectionHeader } from '../../ui/PageHeader'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { StatusBadge } from '../../ui/StatusBadge'
import { NavLink } from '../../app/nav'
import { ActivityRow } from '../activity/ActivityRow'
import { useSession } from '../auth/useSession'
import { IssueForm, type IssueInput } from '../work/CoreForms'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <SectionHeader title={title} />
      {children}
    </section>
  )
}

function IssueLine({ slug, issue }: { slug: string; issue: Issue }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <NavLink to={`/w/${slug}/issues/${issue.key}`} className="shrink-0 text-grey-500">
        {issue.key}
      </NavLink>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{issue.title}</span>
      <StatusBadge status={issue.status} />
    </div>
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
    <div className="flex items-start gap-2 py-1">
      <NavLink to={`/w/${slug}/milestones/${milestone.id}`} className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {milestone.name}
      </NavLink>
      <span className="shrink-0 text-grey-500">
        {counts.done ?? 0}/{total}
      </span>
    </div>
  )
}

export function Dashboard({ slug }: { slug: string }) {
  useStream(slug)
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

  if (query.isPending) return <LoadingState />
  if (query.error) {
    return (
      <ErrorState
        message="Could not load the dashboard."
        onRetry={() => void query.refetch()}
        retrying={query.isRefetching}
      />
    )
  }

  const data = query.data
  const groups = groupByMilestone(data.my_issues, data.milestones)

  return (
    <div className="max-w-[80rem]">
      <PageHeader
        title="Dashboard"
        description="Your current sprint, assigned work, and latest activity in one view."
        actions={canWrite && !creatingIssue ? (
          <Button variant="primary" onClick={() => setCreatingIssue(true)}>New issue</Button>
        ) : undefined}
      />

      {canWrite && creatingIssue ? (
        <section className="ui-surface mb-6 p-4" aria-labelledby="dashboard-new-issue-heading">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="dashboard-new-issue-heading" className="font-medium">New unfiled issue</h2>
              <p className="mt-1 text-sm text-grey-500">Capture work now and organise it later.</p>
            </div>
            <Button onClick={() => setCreatingIssue(false)}>Cancel</Button>
          </div>
          <IssueForm onSubmit={async (input) => {
            await createIssue.mutateAsync(input)
            setCreatingIssue(false)
          }} />
        </section>
      ) : null}

      {data.unread_mentions > 0 ? (
        <p className="ui-surface mb-6 bg-grey-100 px-3 py-2 text-sm">
          <NavLink to={`/w/${slug}/mentions`} className="underline">
            {data.unread_mentions} unread{' '}
            {data.unread_mentions === 1 ? 'mention' : 'mentions'}
          </NavLink>
        </p>
      ) : null}

      <div className="grid gap-x-8 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,30rem)]">
        <div className="min-w-0">
          <Section title={data.active_sprint ? `Sprint ${data.active_sprint.name}` : 'Sprint'}>
            {data.milestones.length === 0 ? (
              <EmptyState
                title={data.active_sprint ? 'No milestones in the current sprint' : 'No active sprint'}
              />
            ) : (
              <div className="divide-y divide-grey-200 border-y border-grey-200">
                {data.milestones.map((m) => (
                  <MilestoneSummary key={m.id} slug={slug} milestone={m} />
                ))}
              </div>
            )}
          </Section>

          <Section title="My open issues">
            {groups.length === 0 ? (
              <EmptyState title="Nothing assigned to you" message="Enjoy the quiet." />
            ) : (
              groups.map(([id, group]) => (
                <div key={id} className="mb-3">
                  <h3 className="text-sm text-grey-500">{group.name}</h3>
                  <div className="divide-y divide-grey-200 border-y border-grey-200">
                    {group.issues.map((issue) => (
                      <IssueLine key={issue.id} slug={slug} issue={issue} />
                    ))}
                  </div>
                </div>
              ))
            )}
          </Section>
        </div>

        <div className="min-w-0">
          <Section title="My recent activity">
            {data.activity.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <div className="divide-y divide-grey-200 border-y border-grey-200">
                {data.activity.map((a) => (
                  <div key={a.id} className="py-1.5">
                    <ActivityRow activity={a} />
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
