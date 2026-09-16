import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { Membership, Role } from '../../lib/types'

import {
  CommandPalette,
} from './CommandPalette'
import { COMMAND_PALETTE_TEST_IDS } from './paletteTestIds'

const membership: Membership = {
  id: 'm1',
  workspace_id: 'w1',
  workspace_slug: 'lab',
  workspace_name: 'Lab',
  issue_prefix: 'ENG',
  role: 'admin' as const,
}

function renderPalette({
  role = 'admin' as Role,
  memberships = [membership] as Membership[],
  initialOpen = false,
} = {}) {
  const navigate = vi.fn()

  function Harness() {
    const [open, setOpen] = useState(initialOpen)
    return (
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        slug="lab"
        role={role}
        memberships={memberships}
        navigate={navigate}
      />
    )
  }

  render(<Harness />)
  return { navigate }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CommandPalette', () => {
  it('opens on Cmd+K and focuses the command input', async () => {
    renderPalette()

    fireEvent.keyDown(document, { key: 'k', metaKey: true })

    const input = await screen.findByTestId(COMMAND_PALETTE_TEST_IDS.input)
    expect(input).toHaveFocus()
    expect(screen.getByTestId(COMMAND_PALETTE_TEST_IDS.root)).toHaveAttribute('data-palette-open', 'true')
  })

  it('also opens on Ctrl+K and closes from the backdrop', async () => {
    const user = userEvent.setup()
    renderPalette()

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    await screen.findByTestId(COMMAND_PALETTE_TEST_IDS.input)
    await user.click(screen.getByTestId(COMMAND_PALETTE_TEST_IDS.backdrop))

    expect(screen.queryByTestId(COMMAND_PALETTE_TEST_IDS.root)).toBeNull()
  })

  it('filters commands by prefix and fuzzy text', async () => {
    const user = userEvent.setup()
    renderPalette({ initialOpen: true })
    const input = screen.getByTestId(COMMAND_PALETTE_TEST_IDS.input)

    await user.type(input, 'rpts')

    expect(screen.getByRole('option', { name: /Reports/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^Dashboard/ })).toBeNull()
  })

  it('wraps selection with arrows and navigates on Enter', async () => {
    const user = userEvent.setup()
    const { navigate } = renderPalette({ initialOpen: true })
    const input = screen.getByTestId(COMMAND_PALETTE_TEST_IDS.input)

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(navigate).toHaveBeenCalledWith('/w/lab/issues')
    expect(screen.queryByTestId(COMMAND_PALETTE_TEST_IDS.root)).toBeNull()
    expect(input).not.toBeInTheDocument()
  })

  it('offers a direct command for an issue key', async () => {
    const user = userEvent.setup()
    const { navigate } = renderPalette({ initialOpen: true })
    const input = screen.getByTestId(COMMAND_PALETTE_TEST_IDS.input)

    await user.type(input, 'eng-42')

    expect(screen.getByRole('option', { name: /Go to ENG-42/ })).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(navigate).toHaveBeenCalledWith('/w/lab/issues/ENG-42')
  })

  it('searches issue titles after a short debounce', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        issues: [{
          id: 'i1', workspace_id: 'w1', key: 'ENG-42', number: 42,
          title: 'Fix login flow', description: '', status: 'todo', priority: 0,
          assignee_id: null, milestone_id: null, parent_id: null, position: 'a',
          created_by: null, created_at: '', updated_at: '',
        }],
      }),
    } as Response))
    const user = userEvent.setup()
    renderPalette({ initialOpen: true })
    const input = screen.getByTestId(COMMAND_PALETTE_TEST_IDS.input)

    await user.type(input, 'login')

    expect(await screen.findByRole('option', { name: /ENG-42 Fix login flow/ })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/v1/w/lab/issues?limit=200', expect.anything())
  })

  it('closes with Escape', async () => {
    const user = userEvent.setup()
    renderPalette({ initialOpen: true })

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByTestId(COMMAND_PALETTE_TEST_IDS.root)).toBeNull())
  })

  it('hides Administration from members', () => {
    renderPalette({
      role: 'member',
      memberships: [{ ...membership, role: 'member' }],
      initialOpen: true,
    })

    expect(screen.queryByRole('option', { name: /^Administration/ })).toBeNull()
    expect(screen.getByRole('option', { name: /^Reports/ })).toBeInTheDocument()
  })
})
