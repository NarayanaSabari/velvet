import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { Membership, Role } from '../../lib/types'

import {
  CommandPalette,
} from './CommandPalette'

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
  // jsdom has no modal dialogs, so stand in for the two calls Astryx makes.
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
  HTMLDialogElement.prototype.close = function close() { this.open = false; this.dispatchEvent(new Event('close')) }
})

/** The palette's search field, once the palette is open. */
function paletteInput() {
  return screen.getByRole('combobox', { name: 'Command palette' })
}

function paletteOpen() {
  return screen.queryByRole('dialog', { name: 'Command palette' }) !== null
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CommandPalette', () => {
  it('opens on Cmd+K and focuses the command input', async () => {
    renderPalette()

    fireEvent.keyDown(document, { key: 'k', metaKey: true })

    const input = await screen.findByRole('combobox', { name: 'Command palette' })
    await waitFor(() => expect(input).toHaveFocus())
    expect(paletteOpen()).toBe(true)
  })

  it('also opens on Ctrl+K', async () => {
    renderPalette()

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })

    // Closing by clicking outside is the browser's own behaviour for a modal
    // dialog, which jsdom does not have, so it is covered end to end.
    expect(await screen.findByRole('combobox', { name: 'Command palette' })).toBeInTheDocument()
  })

  it('filters commands by prefix and fuzzy text', async () => {
    const user = userEvent.setup()
    renderPalette({ initialOpen: true })
    const input = paletteInput()

    await user.type(input, 'rpts')

    expect(await screen.findByRole('option', { name: /Reports/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('option', { name: /^Dashboard/ })).toBeNull())
  })

  it('moves the highlight with arrows and navigates on Enter', async () => {
    const user = userEvent.setup()
    const { navigate } = renderPalette({ initialOpen: true })
    await screen.findByRole('option', { name: /^Dashboard/ })
    await user.click(paletteInput())

    // The first arrow highlights the first row, the second moves to Issues.
    await user.keyboard('{ArrowDown}{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(navigate).toHaveBeenCalledWith('/w/lab/issues')
    await waitFor(() => expect(paletteOpen()).toBe(false))
  })

  it('offers agent setup by the words people search for', async () => {
    const user = userEvent.setup()
    const { navigate } = renderPalette({ initialOpen: true })

    await user.type(paletteInput(), 'velvet init')
    expect(await screen.findByRole('option', { name: /Agent config/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    await user.keyboard('{Enter}')
    expect(navigate).toHaveBeenCalledWith('/w/lab/settings/profile/agent-config')
  })

  it('offers a direct command for an issue key', async () => {
    const user = userEvent.setup()
    const { navigate } = renderPalette({ initialOpen: true })
    const input = paletteInput()

    await user.type(input, 'eng-42')

    expect(await screen.findByRole('option', { name: /Go to ENG-42/ })).toBeInTheDocument()
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
    const input = paletteInput()

    await user.type(input, 'login')

    expect(await screen.findByRole('option', { name: /ENG-42 Fix login flow/ })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/v1/w/lab/issues?q=login&limit=20', expect.anything())
  })

  it('shows an issue title once', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ issues: [{ id: 'i1', key: 'ENG-7', number: 7, title: 'Only once' }] }),
    } as Response))
    const outside = document.createElement('button')
    document.body.append(outside)
    const user = userEvent.setup()
    renderPalette({ initialOpen: true })

    await user.type(paletteInput(), 'once')
    const option = await screen.findByRole('option', { name: 'ENG-7 Only once' })
    expect(option.textContent).toBe('ENG-7 Only once')

    outside.remove()
  })

  it('offers Projects and My work log', async () => {
    const user = userEvent.setup()
    const { navigate } = renderPalette({ initialOpen: true })
    expect(await screen.findByRole('option', { name: /^Projects/ })).toBeInTheDocument()
    await user.type(paletteInput(), 'work log')
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    await user.keyboard('{Enter}')
    expect(navigate).toHaveBeenCalledWith('/me/worklog')
  })

  it('opens the new issue form in its own dialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ milestones: [], issues: [] }) } as Response))
    const user = userEvent.setup()
    renderPalette({ initialOpen: true })

    await user.type(paletteInput(), 'new issue')
    await screen.findByRole('option', { name: /^New issue/ })
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('dialog', { name: 'New issue' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeInTheDocument()
    await waitFor(() => expect(paletteOpen()).toBe(false))
  })

  it('still runs a row after an older, slower search finishes', async () => {
    const user = userEvent.setup()
    const { navigate } = renderPalette({ initialOpen: true })

    // "re" starts a search that is overtaken by "reports" before it answers.
    await user.type(paletteInput(), 'reports')
    await screen.findByRole('option', { name: /^Reports/ })
    await new Promise((resolve) => setTimeout(resolve, 400))
    await user.keyboard('{Enter}')

    expect(navigate).toHaveBeenCalledWith('/w/lab/reports')
  })

  it('closes with Escape', async () => {
    const user = userEvent.setup()
    renderPalette({ initialOpen: true })

    await user.keyboard('{Escape}')

    await waitFor(() => expect(paletteOpen()).toBe(false))
  })

  it('hides Administration from members', async () => {
    renderPalette({
      role: 'member',
      memberships: [{ ...membership, role: 'member' }],
      initialOpen: true,
    })

    expect(await screen.findByRole('option', { name: /^Reports/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^Administration/ })).toBeNull()
  })
})
