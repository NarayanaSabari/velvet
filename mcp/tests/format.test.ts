import { describe, expect, it } from 'vitest'

import {
  formatCreatedTicket,
  formatIssueList,
  formatMilestones,
  formatTicket,
} from '../src/format.js'

describe('response formatting', () => {
  it('formats a compact issue list with status and assignee', () => {
    expect(
      formatIssueList(
        [
          { key: 'ENG-42', title: 'Ship MCP server', status: 'in_progress', assignee_id: 'user-1' },
          { key: 'ENG-43', title: 'Write docs', status: 'backlog', assignee_id: null },
        ],
        'personal',
      ),
    ).toBe(
      'Issues in personal:\n' +
        'ENG-42 | in_progress | Ship MCP server | assignee: user-1\n' +
        'ENG-43 | backlog | Write docs | assignee: unassigned',
    )
  })

  it('formats a ticket and only the ten most recent top-level comments', () => {
    const comments = Array.from({ length: 11 }, (_, index) => ({
      body: `Entry ${index + 1}`,
      author: { name: 'Sabari' },
    }))
    const output = formatTicket(
      {
        issue: {
          key: 'ENG-42',
          title: 'Ship MCP server',
          description: 'Use typed tools.',
          status: 'in_review',
          priority: 2,
          assignee_id: null,
        },
        comments,
      },
      'personal',
    )

    expect(output).toContain('ENG-42: Ship MCP server')
    expect(output).toContain('Status: in_review')
    expect(output).toContain('Recent comments (10):')
    expect(output).not.toMatch(/^- Sabari: Entry 1$/m)
    expect(output).toContain('Entry 2')
    expect(output).toContain('Entry 11')
  })

  it('formats creation and milestone results as text, not JSON', () => {
    expect(
      formatCreatedTicket(
        { key: 'ENG-1', title: 'First ticket', status: 'backlog' },
        'https://worklog.example.com/w/personal/issues/ENG-1',
      ),
    ).toContain('URL: https://worklog.example.com/w/personal/issues/ENG-1')
    expect(
      formatMilestones([{ id: 'm-1', name: 'Launch', status: 'in_progress' }], 'personal'),
    ).toBe('Milestones in personal:\nm-1 | Launch | in_progress')
  })
})
