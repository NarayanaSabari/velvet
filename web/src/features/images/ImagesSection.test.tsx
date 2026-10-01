import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { api } from '../../lib/api'
import { ImagesSection, type ImageAttachment } from './ImagesSection'
import { protectedImageUrl } from './protectedImageUrl'

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), del: vi.fn() } }))
const session = vi.hoisted(() => ({ user: { id: 'owner' }, workspace: { role: 'member' } }))
vi.mock('../auth/useSession', () => ({ useSession: () => session }))

const image: ImageAttachment = {
  id: 'image-1', filename: 'screen.png', caption: 'Design reference', content_type: 'image/png',
  byte_size: 2048, width: 1280, height: 900, created_at: '2026-10-01T10:00:00Z',
  uploader_id: 'owner', uploader_name: 'Sabari', source: 'agent',
  content_url: '/api/v1/w/lab/images/image-1/content',
  download_url: '/api/v1/w/lab/images/image-1/content?download=1',
}

function mount(target: 'issues' | 'milestones' = 'issues') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><ImagesSection slug="lab" target={target} targetId="ENG-1" /></QueryClientProvider>)
  return client
}

beforeEach(() => {
  vi.resetAllMocks()
  session.user.id = 'owner'
  session.workspace.role = 'member'
  vi.mocked(api.get).mockResolvedValue({ images: [image] })
  vi.mocked(api.del).mockResolvedValue(undefined)
})
afterEach(cleanup)

describe('protected image URLs', () => {
  it('accepts only the exact protected workspace and image endpoint', () => {
    expect(protectedImageUrl('/api/v1/w/lab/images/../content', 'lab', '..', 'content')).toBeNull()
    expect(protectedImageUrl(image.content_url, 'lab', image.id, 'content')).toBe(image.content_url)
    expect(protectedImageUrl(image.download_url, 'lab', image.id, 'download')).toBe(image.download_url)
    for (const url of ['https://evil.test/image', '//evil.test/image', 'data:image/png,x', '/api/v1/w/other/images/image-1/content', '/api/v1/w/lab/images/other/content', image.content_url + '/../../me', image.content_url + '?redirect=https://evil.test', image.content_url.replace('/content', '/%2e%2e/content')]) {
      expect(protectedImageUrl(url, 'lab', image.id, 'content')).toBeNull()
    }
  })
})

describe('ImagesSection', () => {
  it('announces loading, then shows the agent-only empty guidance without upload controls', async () => {
    let resolve!: (value: { images: ImageAttachment[] }) => void
    vi.mocked(api.get).mockReturnValue(new Promise((done) => { resolve = done }))
    mount()
    expect(screen.getByText('Loading images…').closest('[role="status"]')).toBeInTheDocument()
    resolve({ images: [] })
    expect(await screen.findByText('No images yet.')).toBeInTheDocument()
    expect(screen.queryByLabelText(/upload/i)).toBeNull()
  })

  it('retries a visible list error', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline'))
    mount('milestones')
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load images')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Design reference')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/w/lab/milestones/ENG-1/images')
  })

  it('renders multiple bounded thumbnails, wrapped metadata, captions, attribution and protected links', async () => {
    vi.mocked(api.get).mockResolvedValue({ images: [image, { ...image, id: 'image-2', filename: 'long'.repeat(80), source: 'user', caption: null, content_url: '/api/v1/w/lab/images/image-2/content', download_url: '/api/v1/w/lab/images/image-2/content?download=1' }] })
    mount()
    const thumbnails = await screen.findAllByRole('img')
    expect(thumbnails).toHaveLength(2)
    expect(thumbnails[0]).toHaveClass('max-h-full', 'max-w-full', 'object-contain')
    expect(thumbnails[0]?.parentElement?.parentElement).toHaveClass('h-32', 'sm:w-40', 'w-full')
    expect(screen.getByText(/Sabari · Agent upload/)).toBeInTheDocument()
    expect(screen.getByText(/Sabari · User upload/)).toBeInTheDocument()
    expect(screen.getAllByText('1280 × 900 · 2 KB · image/png')).toHaveLength(2)
    expect(document.querySelectorAll('time')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Download: screen.png' })).toHaveAttribute('href', image.download_url)
    expect(screen.getAllByRole('link', { name: 'Open full image: screen.png (new tab)' })[0]).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('shows a broken preview while retaining original/download links', async () => {
    mount()
    fireEvent.error(await screen.findByRole('img'))
    expect(screen.getByText('Image preview unavailable.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Download/ })).toBeInTheDocument()
  })

  it('never renders untrusted image or link URLs', async () => {
    vi.mocked(api.get).mockResolvedValue({ images: [{ ...image, content_url: 'https://evil.test/image.png', download_url: '//evil.test/download' }] })
    mount()
    await screen.findByText('Image preview unavailable.')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it.each([['member', 'other', false], ['viewer', 'other', false], ['viewer', 'owner', false], ['admin', 'other', true], ['member', 'owner', true]])('enforces uploader/admin controls for %s %s', async (role, userId, allowed) => {
    session.user.id = userId as string
    session.workspace.role = role as string
    mount()
    await screen.findByText('Design reference')
    expect(Boolean(screen.queryByRole('button', { name: 'Delete image: screen.png' }))).toBe(allowed)
  })

  it('supports keyboard confirmation and returns focus on cancellation', async () => {
    const user = userEvent.setup()
    mount()
    const trigger = await screen.findByRole('button', { name: 'Delete image: screen.png' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(api.del).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Delete image: screen.png' })).toHaveFocus()
    expect(screen.queryByText(/cannot be undone/)).toBeNull()
  })

  it('keeps failed confirmation visible and retries deletion with pending state', async () => {
    const user = userEvent.setup()
    vi.mocked(api.del).mockRejectedValueOnce(new Error('denied'))
    mount()
    await user.click(await screen.findByRole('button', { name: 'Delete image: screen.png' }))
    await user.click(screen.getByRole('button', { name: 'Delete image' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete image')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    let resolve!: () => void
    vi.mocked(api.del).mockReturnValue(new Promise<void>((done) => { resolve = done }))
    await user.click(screen.getByRole('button', { name: 'Delete image' }))
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    vi.mocked(api.get).mockResolvedValue({ images: [] })
    resolve()
    await waitFor(() => expect(screen.queryByText('screen.png')).toBeNull())
    expect(screen.getByRole('heading', { name: 'Images' })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Deleted image: screen.png')
    expect(api.del).toHaveBeenCalledWith('/w/lab/images/image-1')
  })
})
