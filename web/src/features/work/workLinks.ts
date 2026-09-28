import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Milestone, Project, Sprint, SprintState } from '../../lib/types'

/**
 * A ticket links to a project and to a milestone, and the two always agree:
 * a milestone sits in one sprint, and a sprint belongs to one project. These
 * helpers build the choices the pickers offer and mirror the server's rule, so
 * the form shows what the save will do.
 */

export interface ProjectChoice {
  id: string
  key: string
  label: string
}

export interface MilestoneChoice {
  id: string
  label: string
  /** The optgroup heading, naming the project and sprint it belongs to. */
  group: string
  projectId: string | null
}

const STATE_ORDER: Record<SprintState, number> = { active: 0, upcoming: 1, completed: 2 }

/** Active projects, plus the current one if it has since been archived. */
export function projectChoices(projects: Project[], currentId?: string | null): ProjectChoice[] {
  return projects
    .filter((project) => project.status === 'active' || project.id === currentId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((project) => ({
      id: project.id,
      key: project.key,
      label: project.status === 'archived' ? `${project.name} (archived)` : project.name,
    }))
}

/**
 * Milestones grouped under "Project · Sprint", active sprints first. Work is
 * not scheduled into a closed sprint, so its milestones are left out unless
 * the ticket is already on one.
 */
export function milestoneChoices(
  milestones: Milestone[],
  sprints: Sprint[],
  projects: Project[],
  currentId?: string | null,
): MilestoneChoice[] {
  const sprintById = new Map(sprints.map((sprint) => [sprint.id, sprint]))
  const projectById = new Map(projects.map((project) => [project.id, project]))

  const rows = milestones.flatMap((milestone) => {
    const sprint = sprintById.get(milestone.sprint_id)
    if (sprint?.state === 'completed' && milestone.id !== currentId) return []
    const project = sprint ? projectById.get(sprint.project_id) : undefined
    const group = sprint
      ? `${project?.name ?? 'Project'} · ${sprint.name}`
      : 'Other milestones'
    return [{ milestone, sprint, project, group }]
  })

  rows.sort((a, b) =>
    (a.project?.name ?? '\uffff').localeCompare(b.project?.name ?? '\uffff')
    || STATE_ORDER[a.sprint?.state ?? 'completed'] - STATE_ORDER[b.sprint?.state ?? 'completed']
    || (b.sprint?.starts_on ?? '').localeCompare(a.sprint?.starts_on ?? '')
    || a.group.localeCompare(b.group)
    || a.milestone.name.localeCompare(b.milestone.name))

  return rows.map(({ milestone, sprint, group }) => ({
    id: milestone.id,
    label: milestone.name,
    group,
    projectId: sprint?.project_id ?? null,
  }))
}

/** Consecutive choices that share a group, in order, for rendering optgroups. */
export function groupChoices<T extends { group?: string }>(choices: T[]): Array<{ group: string; items: T[] }> {
  const groups: Array<{ group: string; items: T[] }> = []
  for (const choice of choices) {
    const group = choice.group ?? ''
    const last = groups.at(-1)
    if (last && last.group === group) last.items.push(choice)
    else groups.push({ group, items: [choice] })
  }
  return groups
}

/**
 * The server's rule, applied ahead of the save: choosing a milestone moves the
 * ticket to that milestone's project, and choosing a different project drops a
 * milestone that belongs to another one.
 */
export function reconcileLinks(
  milestones: MilestoneChoice[],
  current: { projectId: string; milestoneId: string },
  change: { projectId?: string; milestoneId?: string },
): { projectId: string; milestoneId: string } {
  if (change.milestoneId !== undefined) {
    const owner = milestones.find((choice) => choice.id === change.milestoneId)?.projectId
    return { milestoneId: change.milestoneId, projectId: owner ?? current.projectId }
  }
  if (change.projectId !== undefined) {
    const owner = milestones.find((choice) => choice.id === current.milestoneId)?.projectId
    const keep = current.milestoneId !== '' && owner === change.projectId
    return { projectId: change.projectId, milestoneId: keep ? current.milestoneId : '' }
  }
  return current
}

/** The project list including archived ones, so old links still have names. */
export function projectsQuery(slug: string) {
  return {
    queryKey: ['projects', slug, true] as const,
    queryFn: () => api.get<{ projects: Project[] }>(`/w/${slug}/projects?include_archived=true`),
  }
}

export function sprintsQuery(slug: string) {
  return {
    queryKey: ['sprints', slug] as const,
    queryFn: () => api.get<{ sprints: Sprint[] }>(`/w/${slug}/sprints`),
  }
}

/** Everything a ticket's project and milestone pickers need, loaded once. */
export function useWorkLinks(slug: string, current?: { projectId?: string | null; milestoneId?: string | null }) {
  const projects = useQuery(projectsQuery(slug))
  const sprints = useQuery(sprintsQuery(slug))
  const milestones = useQuery({
    queryKey: ['milestones', slug, 'all'],
    queryFn: () => api.get<{ milestones: Milestone[] }>(`/w/${slug}/milestones`),
  })

  const projectList = useMemo(() => projects.data?.projects ?? [], [projects.data])
  const currentProjectId = current?.projectId
  const currentMilestoneId = current?.milestoneId

  return {
    projects: useMemo(() => projectChoices(projectList, currentProjectId), [projectList, currentProjectId]),
    milestones: useMemo(
      () => milestoneChoices(
        milestones.data?.milestones ?? [],
        sprints.data?.sprints ?? [],
        projectList,
        currentMilestoneId,
      ),
      [milestones.data, sprints.data, projectList, currentMilestoneId],
    ),
    projectById: useMemo(() => new Map(projectList.map((project) => [project.id, project])), [projectList]),
    milestoneById: useMemo(
      () => new Map((milestones.data?.milestones ?? []).map((milestone) => [milestone.id, milestone])),
      [milestones.data],
    ),
  }
}
