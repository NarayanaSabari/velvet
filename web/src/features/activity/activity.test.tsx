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
})
