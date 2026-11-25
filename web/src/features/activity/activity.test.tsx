import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { ActivityRow } from './ActivityRow'
import type { Activity } from '../../lib/types'

const actor = { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' }

function row(overrides: Partial<Activity>): Activity {
  return {
    id: 1,
    workspace_id: 'w1',
    actor,
    verb: 'commented',
    target_type: 'issue',
    target_id: 'i1',
    metadata: {},
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('ActivityRow', () => {
  it('labels email invitations without a GitHub prefix', () => {
    render(<ActivityRow activity={row({ verb: 'invited_member', metadata: { email: 'person@example.com', role: 'viewer' } })} />)
    expect(screen.getByText('invited person@example.com as viewer')).toBeInTheDocument()
  })
  it('labels role changes using the current email metadata', () => {
    render(<ActivityRow activity={row({ verb: 'changed_member_role', metadata: { email: 'person@example.com', from: 'member', to: 'viewer' } })} />)
    expect(screen.getByText('changed person@example.com from member to viewer')).toBeInTheDocument()
  })
  it('describes a comment with its excerpt', () => {
    render(<ActivityRow activity={row({
      verb: 'commented',
      metadata: { key: 'ENG-1', excerpt: 'Started on this today' },
    })} />)
    expect(screen.getByText(/commented/i)).toBeInTheDocument()
    expect(screen.getByText(/Started on this today/)).toBeInTheDocument()
  })

  it('describes a status change with both states', () => {
    render(<ActivityRow activity={row({
      verb: 'changed_status',
      metadata: { key: 'ENG-1', from: 'todo', to: 'in_progress' },
    })} />)
    expect(screen.getByText(/Todo/)).toBeInTheDocument()
    expect(screen.getByText(/In progress/)).toBeInTheDocument()
  })

  it('describes an attached PR as evidence', () => {
    render(<ActivityRow activity={row({
      verb: 'attached_pr',
      metadata: { key: 'ENG-1', number: 42 },
    })} />)
    expect(screen.getByText(/#42/)).toBeInTheDocument()
  })

  it('renders an unknown verb without crashing', () => {
    render(<ActivityRow activity={row({ verb: 'invented_verb', metadata: {} })} />)
    expect(screen.getByText(/sabari/i)).toBeInTheDocument()
  })

  it('survives a deleted actor', () => {
    render(<ActivityRow activity={row({ actor: null, verb: 'commented' })} />)
    expect(screen.getByText(/someone/i)).toBeInTheDocument()
  })

  it('names membership administration changes', () => {
    const { rerender } = render(
      <ActivityRow activity={row({
        verb: 'invited_member',
        target_type: 'membership',
        metadata: { github_login: 'octocat', role: 'member' },
      })} />,
    )
    expect(screen.getByText(/invited @octocat as member/i)).toBeInTheDocument()

    rerender(
      <ActivityRow activity={row({
        verb: 'changed_member_role',
        target_type: 'membership',
        metadata: { github_login: 'octocat', from: 'member', to: 'admin' },
      })} />,
    )
    expect(screen.getByText(/changed @octocat from member to admin/i)).toBeInTheDocument()
  })
})

describe('ActivityRow targets', () => {
  it('names a milestone comment instead of dangling on "commented on"', () => {
    render(
      <ActivityRow
        activity={row({
          verb: 'commented',
          target_type: 'milestone',
          metadata: { name: 'Ship auth', excerpt: 'On track.' },
        })}
      />,
    )
    expect(screen.getByText('Ship auth')).toBeInTheDocument()
  })

  it('still names a target when metadata carries nothing useful', () => {
    const { container } = render(
      <ActivityRow activity={row({ verb: 'commented', target_type: 'issue', metadata: {} })} />,
    )
    // The sentence must not end on a preposition.
    expect(container.textContent).not.toMatch(/commented on\s*$/)
    expect(screen.getByText('an issue')).toBeInTheDocument()
  })

  it('names the target an attached PR belongs to', () => {
    const { container } = render(
      <ActivityRow
        activity={row({ verb: 'attached_pr', target_type: 'issue', metadata: { number: 42 } })}
      />,
    )
    expect(container.textContent).not.toMatch(/to\s*$/)
  })

  describe('links', () => {
    it('names things as plain text when it does not know the organisation', () => {
      render(<ActivityRow activity={row({ verb: 'changed_status', metadata: { key: 'ENG-1', from: 'todo', to: 'done' } })} />)
      expect(screen.getByText('ENG-1')).toBeInTheDocument()
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
    })

    it('links an issue key to its issue', () => {
      render(<ActivityRow slug="lab" activity={row({ verb: 'changed_status', metadata: { key: 'ENG-1', from: 'todo', to: 'done' } })} />)
      expect(screen.getByRole('link', { name: 'ENG-1' })).toHaveAttribute('href', '/w/lab/issues/ENG-1')
    })

    it('links a milestone comment to the milestone it was written on', () => {
      render(<ActivityRow slug="lab" activity={row({
        verb: 'commented',
        target_type: 'comment',
        target_id: 'c1',
        metadata: { target_type: 'milestone', target_id: 'm1', name: 'Ship auth', excerpt: 'On track' },
      })} />)
      expect(screen.getByRole('link', { name: 'Ship auth' })).toHaveAttribute('href', '/w/lab/milestones/m1')
    })

    it('keeps a project comment labelled by its key, without an issue link', () => {
      render(<ActivityRow slug="lab" activity={row({
        verb: 'commented',
        target_type: 'comment',
        target_id: 'c1',
        metadata: { target_type: 'project', target_id: 'p1', key: 'portal', name: 'Customer Portal' },
      })} />)
      expect(screen.getByText('portal')).toBeInTheDocument()
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
    })

    it('links a completed milestone and a closed sprint', () => {
      const { unmount } = render(<ActivityRow slug="lab" activity={row({
        verb: 'completed_milestone', target_type: 'milestone', target_id: 'm1', metadata: { name: 'Ship auth' },
      })} />)
      expect(screen.getByRole('link', { name: 'Ship auth' })).toHaveAttribute('href', '/w/lab/milestones/m1')
      unmount()

      render(<ActivityRow slug="lab" activity={row({
        verb: 'closed_sprint', target_type: 'sprint', target_id: 's1', metadata: { name: 'Sprint 4' },
      })} />)
      expect(screen.getByRole('link', { name: 'Sprint 4' })).toHaveAttribute('href', '/w/lab/sprints/s1')
    })

    it('opens a pull request on GitHub in a new tab', () => {
      render(<ActivityRow slug="lab" activity={row({
        verb: 'attached_pr',
        metadata: { key: 'ENG-1', number: 218, html_url: 'https://github.com/acme/widgets/pull/218' },
      })} />)
      const link = screen.getByRole('link', { name: '#218' })
      expect(link).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/218')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
    })

    it('never turns a non-web address into a pull request link', () => {
      render(<ActivityRow activity={row({
        verb: 'attached_pr',
        metadata: { key: 'ENG-1', number: 218, html_url: 'javascript:alert(1)' },
      })} />)
      expect(screen.getByText('#218')).toBeInTheDocument()
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
    })
  })

  describe('hideActor', () => {
    it('names the actor by default', () => {
      render(<ActivityRow activity={row({ verb: 'closed_sprint', metadata: { name: 'Sprint 4' } })} />)
      expect(screen.getByText('Sabari')).toBeInTheDocument()
    })

    it('starts with the action in a list that is all one person', () => {
      render(<ActivityRow hideActor activity={row({ verb: 'closed_sprint', metadata: { name: 'Sprint 4' } })} />)
      expect(screen.queryByText('Sabari')).not.toBeInTheDocument()
      expect(screen.getByText(/closed sprint/)).toBeInTheDocument()
    })
  })
})
