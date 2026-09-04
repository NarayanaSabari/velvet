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
})
