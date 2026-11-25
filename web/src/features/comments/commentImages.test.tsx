import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CommentComposer } from './CommentComposer'
import { CommentThread } from './CommentThread'

const imageID = 'img1'
const image = {
  id: imageID, filename: 'login.png', caption: 'Login screen', content_type: 'image/png', byte_size: 10,
  width: 1280, height: 720, created_at: '2026-01-01T00:00:00Z', uploader_id: 'u1', uploader_name: 'Sabari',
  source: 'agent', content_url: `/api/v1/w/lab/images/${imageID}/content`, download_url: `/api/v1/w/lab/images/${imageID}/content?download=1`,
}

describe('comment images', () => {
  it('shows attached screenshots inside the comment', () => {
    render(<CommentThread slug="lab" comments={[{
      id: 'c1', workspace_id: 'w1', target_type: 'milestone', target_id: 'm1', parent_id: null,
      author: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
      body: 'Proof below', created_at: '2026-01-01T00:00:00Z', edited_at: null, deleted_at: null,
      images: [image],
    }]} />)
    const img = screen.getByRole('img', { name: 'Login screen' })
    expect(img).toHaveAttribute('src', image.content_url)
    expect(screen.getByRole('button', { name: 'View image: Login screen' })).toBeInTheDocument()
  })

  it('refuses an image URL from another workspace', () => {
    render(<CommentThread slug="other" comments={[{
      id: 'c1', workspace_id: 'w1', target_type: 'milestone', target_id: 'm1', parent_id: null,
      author: { id: 'u1', github_login: 'sabari', name: 'Sabari', avatar_url: '' },
      body: 'Proof below', created_at: '2026-01-01T00:00:00Z', edited_at: null, deleted_at: null,
      images: [image],
    }]} />)
    // The author's avatar is also announced as an image, so look for a picture element.
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('Image preview unavailable.')).toBeInTheDocument()
  })

  it('uploads picked images to the comment it just posted', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ id: 'new-comment' })
    const onAttach = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} onAttach={onAttach} />)

    const file = new File(['png'], 'proof.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Attach images'), file)
    expect(screen.getByText('proof.png')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Comment' }), 'Done')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() => expect(onAttach).toHaveBeenCalledWith('new-comment', [file]))
    await waitFor(() => expect(screen.queryByText('proof.png')).not.toBeInTheDocument())
  })

  it('keeps the images when their upload fails', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ id: 'new-comment' })
    const onAttach = vi.fn().mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    render(<CommentComposer onSubmit={onSubmit} onAttach={onAttach} />)

    await user.upload(screen.getByLabelText('Attach images'), new File(['png'], 'proof.png', { type: 'image/png' }))
    await user.type(screen.getByRole('textbox', { name: 'Comment' }), 'Done')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Comment posted, but the images did not upload')
    expect(screen.getByText('proof.png')).toBeInTheDocument()
  })
})
