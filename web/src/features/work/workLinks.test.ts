import { describe, expect, it } from 'vitest'

import type { Milestone, Project, Sprint } from '../../lib/types'
import { groupChoices, milestoneChoices, projectChoices, reconcileLinks } from './workLinks'

const project = (id: string, name: string, status: Project['status'] = 'active'): Project => ({
  id, workspace_id: 'w', key: name.toLowerCase(), name, description: '', status,
  created_at: '', updated_at: '', archived_at: null,
})
const sprint = (id: string, projectId: string, name: string, state: Sprint['state'], startsOn: string): Sprint => ({
  id, workspace_id: 'w', project_id: projectId, name, starts_on: startsOn, ends_on: startsOn,
  state, created_at: '', completed_at: null,
})
const milestone = (id: string, sprintId: string, name: string): Milestone => ({
  id, workspace_id: 'w', sprint_id: sprintId, name, description: '', owner_id: null,
  target_date: null, status: 'planned', position: 'a', created_at: '', updated_at: '',
})

const projects = [project('p-web', 'Web'), project('p-api', 'API'), project('p-old', 'Old', 'archived')]
const sprints = [
  sprint('s-web-sep', 'p-web', 'September', 'active', '2026-09-01'),
  sprint('s-web-oct', 'p-web', 'October', 'upcoming', '2026-10-01'),
  sprint('s-web-aug', 'p-web', 'August', 'completed', '2026-08-01'),
  sprint('s-api-sep', 'p-api', 'September', 'active', '2026-09-01'),
]
const milestones = [
  milestone('m-oct', 's-web-oct', 'Launch'),
  milestone('m-aug', 's-web-aug', 'Retired'),
  milestone('m-sep', 's-web-sep', 'Onboarding'),
  milestone('m-api', 's-api-sep', 'Rate limits'),
]

describe('work links', () => {
  it('offers active projects, keeping an archived one only when it is current', () => {
    expect(projectChoices(projects).map((choice) => choice.label)).toEqual(['API', 'Web'])
    expect(projectChoices(projects, 'p-old').map((choice) => choice.label))
      .toEqual(['API', 'Old (archived)', 'Web'])
  })

  it('groups milestones by project and sprint, active first, and hides closed sprints', () => {
    const choices = milestoneChoices(milestones, sprints, projects)
    expect(choices.map((choice) => [choice.group, choice.label])).toEqual([
      ['API · September', 'Rate limits'],
      ['Web · September', 'Onboarding'],
      ['Web · October', 'Launch'],
    ])
    expect(choices.find((choice) => choice.id === 'm-api')?.projectId).toBe('p-api')
    expect(groupChoices(choices).map((group) => group.group))
      .toEqual(['API · September', 'Web · September', 'Web · October'])
  })

  it('keeps a closed sprint milestone the ticket is already on', () => {
    const choices = milestoneChoices(milestones, sprints, projects, 'm-aug')
    expect(choices.map((choice) => choice.id)).toContain('m-aug')
  })

  it('mirrors the server rule for keeping project and milestone in step', () => {
    const choices = milestoneChoices(milestones, sprints, projects)
    const none = { projectId: '', milestoneId: '' }

    // A milestone brings its project with it.
    expect(reconcileLinks(choices, none, { milestoneId: 'm-api' }))
      .toEqual({ projectId: 'p-api', milestoneId: 'm-api' })
    // The same project keeps the milestone.
    expect(reconcileLinks(choices, { projectId: 'p-web', milestoneId: 'm-sep' }, { projectId: 'p-web' }))
      .toEqual({ projectId: 'p-web', milestoneId: 'm-sep' })
    // Another project, or none, drops it.
    expect(reconcileLinks(choices, { projectId: 'p-web', milestoneId: 'm-sep' }, { projectId: 'p-api' }))
      .toEqual({ projectId: 'p-api', milestoneId: '' })
    expect(reconcileLinks(choices, { projectId: 'p-web', milestoneId: 'm-sep' }, { projectId: '' }))
      .toEqual({ projectId: '', milestoneId: '' })
    // Clearing the milestone leaves the project alone.
    expect(reconcileLinks(choices, { projectId: 'p-web', milestoneId: 'm-sep' }, { milestoneId: '' }))
      .toEqual({ projectId: 'p-web', milestoneId: '' })
  })
})
