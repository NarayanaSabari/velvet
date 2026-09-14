import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CommentComposer } from './CommentComposer'

describe('CommentComposer', () => {
  it('submits on Cmd+Enter', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    await user.type(screen.getByRole('textbox'), 'Progress update')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onSubmit).toHaveBeenCalledWith('Progress update')
  })

  it('refuses an empty body', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    await user.type(screen.getByRole('textbox'), '   ')
    await user.click(screen.getByRole('button', { name: /comment/i }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the draft when submission fails, so nobody loses their writing', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    const box = screen.getByRole('textbox')
    await user.type(box, 'A long update worth keeping')
    await user.click(screen.getByRole('button', { name: /comment/i }))

    expect(box).toHaveValue('A long update worth keeping')
  })

  it('preserves edits made while submission is pending', async () => {
    let resolveSubmit!: () => void
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve
        }),
    )
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    const box = screen.getByRole('textbox')
    await user.type(box, 'Original update')
    await user.click(screen.getByRole('button', { name: /comment/i }))
    await user.clear(box)
    await user.type(box, 'New draft typed while saving')
    resolveSubmit()

    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled())
    expect(box).toHaveValue('New draft typed while saving')
  })

  it('clears an unchanged draft after submission resolves', async () => {
    let resolveSubmit!: () => void
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve
        }),
    )
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    const box = screen.getByRole('textbox')
    await user.type(box, 'Original update')
    await user.click(screen.getByRole('button', { name: /comment/i }))
    resolveSubmit()

    await waitFor(() => expect(box).toHaveValue(''))
  })
})
