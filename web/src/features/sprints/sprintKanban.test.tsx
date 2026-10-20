import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { IssueStatus } from '../../lib/types'
import type { SprintIssue } from './SprintBoard'
import { MoveToast, SprintKanban } from './SprintKanban'

const issue = (n: number, status: IssueStatus, extra: Partial<SprintIssue> = {}): SprintIssue => ({
  id: `i${n}`,
  workspace_id: 'w1',
  key: `ENG-${n}`,
  number: n,
  title: `Issue ${n}`,
  description: '',
  status,
  priority: 2,
  assignee_id: null,
  milestone_id: null,
  project_id: null,
  parent_id: null,
  position: 'V',
  created_by: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: new Date().toISOString(),
  ...extra,
})

function board(issues: SprintIssue[], canWrite = true) {
  const onMove = vi.fn()
  const onOpen = vi.fn()
  render(
    <SprintKanban issues={issues} members={[]} milestones={[]} canWrite={canWrite} onOpen={onOpen} onMove={onMove} />,
  )
  return { onMove, onOpen }
}

/** jsdom has no DataTransfer, so carry the payload the way a browser would. */
function dataTransfer() {
  const store = new Map<string, string>()
  return {
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()]
    },
    effectAllowed: 'all',
    dropEffect: 'none',
  }
}

describe('SprintKanban', () => {
  it('shows five columns in workflow order with counts, and folds cancelled under Done', () => {
    board([issue(1, 'backlog'), issue(2, 'todo'), issue(3, 'todo'), issue(4, 'done'), issue(5, 'cancelled')])

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(headings).toEqual(['Backlog1', 'Todo2', 'In progress0', 'In review0', 'Done1'])
    expect(screen.getByTestId('kanban-cancelled')).toHaveTextContent('Cancelled · 1')
    expect(within(screen.getByTestId('kanban-column-in_progress')).getByText('Drop issues here')).toBeInTheDocument()
  })

  it('shows only the latest Done cards until Show all is chosen', async () => {
    board([1, 2, 3, 4, 5].map((n) => issue(n, 'done')))
    const done = screen.getByTestId('kanban-column-done')

    expect(within(done).getAllByRole('listitem')).toHaveLength(3)
    await userEvent.click(within(done).getByRole('button', { name: '+ 2 more · Show all' }))
    expect(within(done).getAllByRole('listitem')).toHaveLength(5)
  })

  it('moves a card when it is dropped on another column', () => {
    const { onMove } = board([issue(7, 'todo')])
    const transfer = dataTransfer()

    fireEvent.dragStart(screen.getByTestId('kanban-card-ENG-7'), { dataTransfer: transfer })
    fireEvent.dragOver(screen.getByTestId('kanban-column-in_progress'), { dataTransfer: transfer })
    expect(screen.getByTestId('kanban-column-in_progress')).toHaveAttribute('data-drop-target', 'true')
    fireEvent.drop(screen.getByTestId('kanban-column-in_progress'), { dataTransfer: transfer })

    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ from: 'todo', to: 'in_progress' }))
  })

  it('ignores a drop back onto the same column', () => {
    const { onMove } = board([issue(7, 'todo')])
    const transfer = dataTransfer()

    fireEvent.dragStart(screen.getByTestId('kanban-card-ENG-7'), { dataTransfer: transfer })
    fireEvent.drop(screen.getByTestId('kanban-column-todo'), { dataTransfer: transfer })

    expect(onMove).not.toHaveBeenCalled()
  })

  it('moves a card from the keyboard through its status menu', async () => {
    const { onMove } = board([issue(8, 'todo')])
    const trigger = within(screen.getByTestId('kanban-card-ENG-8')).getByRole('button', { name: 'Status' })

    trigger.focus()
    await userEvent.keyboard('{ArrowDown}{Enter}')

    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ from: 'todo', to: 'in_progress' }))
  })

  it('opens the issue from its title', async () => {
    const { onOpen } = board([issue(9, 'backlog')])
    await userEvent.click(screen.getByRole('link', { name: 'Issue 9' }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'ENG-9' }))
  })

  it('is read-only for viewers: no dragging and no status menu', () => {
    board([issue(10, 'todo')], false)
    const card = screen.getByTestId('kanban-card-ENG-10')

    expect(card).toHaveAttribute('draggable', 'false')
    expect(within(card).queryByRole('button', { name: 'Status' })).toBeNull()
  })

  it('names unfinished work that has gone quiet', () => {
    board([issue(11, 'in_progress', { updated_at: new Date(Date.now() - 6 * 864e5).toISOString() })])
    expect(screen.getByText('silent 6d')).toBeInTheDocument()
  })
})

describe('MoveToast', () => {
  const move = { issue: issue(12, 'todo'), from: 'todo' as const, to: 'in_progress' as const }

  it('reports the move and offers Undo', async () => {
    const onUndo = vi.fn()
    render(<MoveToast move={move} failed={false} onUndo={onUndo} onDismiss={vi.fn()} />)

    expect(screen.getByRole('status')).toHaveTextContent('Moved ENG-12 to In progress')
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onUndo).toHaveBeenCalled()
  })

  it('says plainly when the server refused the move', () => {
    render(<MoveToast move={move} failed onUndo={vi.fn()} onDismiss={vi.fn()} />)

    expect(screen.getByRole('status')).toHaveTextContent('Could not move ENG-12. It is back in Todo.')
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})
