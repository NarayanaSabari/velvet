import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Issue } from '../../lib/types'
import { IssueList } from './IssueList'

const issue: Issue = {
  id: 'i1',
  workspace_id: 'w1',
  key: 'ENG-1',
  number: 1,
  title: 'Supercalifragilisticexpialidocious_identifier_that_never_breaks_across_lines',
  description: '',
  status: 'in_progress',
  priority: 1,
  assignee_id: null,
  milestone_id: null,
  project_id: null,
  parent_id: null,
  position: 'a',
  created_by: null,
  created_at: '',
  updated_at: '',
}

describe('IssueList', () => {
  it('keeps the full issue title readable instead of truncating it', () => {
    render(<IssueList issues={[issue]} />)

    expect(screen.getByText(issue.title)).toHaveClass(
      'break-words',
      '[overflow-wrap:anywhere]',
    )
    expect(screen.getByText(issue.title)).not.toHaveClass('truncate')
    expect(screen.getByText('In progress').parentElement).toHaveClass('col-start-2')
  })
})
