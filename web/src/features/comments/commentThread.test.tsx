import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CommentComposer } from './CommentComposer'
import { CommentThread } from './CommentThread'

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

describe('CommentThread', () => {
  it('lets a writer reply to a top-level update', async () => {
    const onReply = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CommentThread comments={[{
      id: 'c1', workspace_id: 'w1', target_type: 'issue', target_id: 'i1',
      parent_id: null, author: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
      body: 'Initial update', created_at: '2026-01-01T00:00:00Z', edited_at: null, deleted_at: null,
    }]} onReply={onReply} />)

    await user.click(screen.getByRole('button', { name: 'Reply' }))
    await user.type(screen.getByPlaceholderText('Write a reply…'), 'Following up')
    await user.click(screen.getByRole('button', { name: 'Post reply' }))

    expect(onReply).toHaveBeenCalledWith('c1', 'Following up')
  })

  it('keeps a reply draft and reports a failed submission', async () => {
    const onReply = vi.fn().mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    render(<CommentThread comments={[{
      id: 'c1', workspace_id: 'w1', target_type: 'issue', target_id: 'i1',
      parent_id: null, author: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
      body: 'Initial update', created_at: '2026-01-01T00:00:00Z', edited_at: null, deleted_at: null,
    }]} onReply={onReply} />)

    await user.click(screen.getByRole('button', { name: 'Reply' }))
    const draft = screen.getByPlaceholderText('Write a reply…')
    await user.type(draft, 'Do not lose this')
    await user.click(screen.getByRole('button', { name: 'Post reply' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not post reply')
    expect(draft).toHaveValue('Do not lose this')
  })
})
