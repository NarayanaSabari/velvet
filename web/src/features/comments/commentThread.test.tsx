import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CommentComposer } from './CommentComposer'
import { CommentThread } from './CommentThread'

describe('CommentComposer', () => {
  it.each(['Meta', 'Control'])('submits on %s+Enter', async (modifier) => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    await user.type(screen.getByRole('textbox'), 'Progress update')
    await user.keyboard(`{${modifier}>}{Enter}{/${modifier}}`)
    expect(onSubmit).toHaveBeenCalledWith('Progress update')
  })

  it('previews Markdown without submitting or losing the draft', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    const box = screen.getByRole('textbox', { name: 'Comment' })
    await user.type(box, '**Progress** update')
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    expect(screen.getByRole('region', { name: 'Comment preview' }).querySelector('strong')).toHaveTextContent('Progress')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
    expect(onSubmit).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Write' }))
    expect(screen.getByRole('textbox')).toHaveValue('**Progress** update')
    expect(screen.getByRole('button', { name: 'Write' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('explains an empty preview', async () => {
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('region', { name: 'Comment preview' })).toHaveTextContent('Nothing to preview yet.')
  })

  it('inserts a fenced Mermaid sample at the caret and restores editor focus', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} />)

    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    await user.type(box, 'BeforeAfter')
    box.setSelectionRange(6, 6)
    await user.click(screen.getByRole('button', { name: '+ Diagram' }))

    const inserted = 'Before\n```mermaid\nflowchart TD\n  A[Start] --> B[Next step]\n```\nAfter'
    expect(box).toHaveValue(inserted)
    await waitFor(() => expect(box).toHaveFocus())
    expect(box.selectionStart).toBe(inserted.length - 'After'.length)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('can insert a diagram from preview without discarding surrounding text', async () => {
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={vi.fn()} />)

    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    await user.type(box, 'Replace this')
    box.setSelectionRange(8, 12)
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await user.click(screen.getByRole('button', { name: '+ Diagram' }))

    expect(screen.getByRole('textbox')).toHaveValue('Replace \n```mermaid\nflowchart TD\n  A[Start] --> B[Next step]\n```\n')
    expect(screen.queryByRole('region', { name: 'Comment preview' })).not.toBeInTheDocument()
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
    expect(screen.getByRole('alert')).toHaveTextContent('Could not post. Your draft is still here')
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
    expect(screen.getByRole('button', { name: 'Commenting…' })).toBeDisabled()
    await user.clear(box)
    await user.type(box, 'New draft typed while saving')
    resolveSubmit()

    await waitFor(() => expect(screen.getByRole('button', { name: /comment/i })).toBeEnabled())
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

describe('CommentThread', () => {
	// If user labels go back to GitHub-only, email-authored history becomes
	// anonymous even though its identity is present in the API response.
	it('shows an email-only comment author', () => {
		render(<CommentThread comments={[{
			id: 'c-email', workspace_id: 'w1', target_type: 'issue', target_id: 'i1',
			parent_id: null,
			author: { id: 'u-email', email: 'member@example.com', github_id: null, github_login: null, name: '', avatar_url: '' },
			body: 'Email-authored update', created_at: '2026-01-01T00:00:00Z', edited_at: null, deleted_at: null,
		}]} />)

		expect(screen.getByText('member@example.com')).toBeInTheDocument()
	})

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
