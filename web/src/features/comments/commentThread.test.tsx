import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
