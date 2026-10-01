import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState, LoadingState } from '../../ui/QueryState'
import { RelativeTime } from '../../ui/RelativeTime'
import { useSession } from '../auth/useSession'
import { protectedImageUrl } from './protectedImageUrl'

export interface ImageAttachment {
  id: string
  filename: string
  caption: string | null
  content_type: string
  byte_size: number
  width: number
  height: number
  created_at: string
  uploader_id: string
  uploader_name: string
  source: string
  content_url: string
  download_url: string
}

function ImageRow({ image, slug, canDelete, onDelete }: {
  image: ImageAttachment
  slug: string
  canDelete: boolean
  onDelete: () => Promise<void>
}) {
  const [broken, setBroken] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const trigger = useRef<HTMLDivElement>(null)
  const wasConfirming = useRef(false)
  const confirmationId = useId()
  const content = protectedImageUrl(image.content_url, slug, image.id, 'content')
  const download = protectedImageUrl(image.download_url, slug, image.id, 'download')
  const removal = useMutation({ mutationFn: onDelete })

  useEffect(() => {
    if (wasConfirming.current && !confirming) trigger.current?.querySelector('button')?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  function closeConfirmation() {
    setConfirming(false)
    removal.reset()
  }

  return (
    <li className="min-w-0 py-3" data-testid={`image-item-${image.id}`}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
        <div className="flex h-32 w-full shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] border border-grey-200 bg-grey-100 sm:w-40">
          {content && !broken ? (
            <a href={content} target="_blank" rel="noopener noreferrer" className="flex h-full w-full items-center justify-center" aria-label={`Open full image: ${image.filename} (new tab)`}>
              <img src={content} alt={image.caption || image.filename} loading="lazy" className="max-h-full max-w-full object-contain" onError={() => setBroken(true)} />
            </a>
          ) : <p className="px-3 text-xs text-grey-700">Image preview unavailable.</p>}
        </div>
        <div className="min-w-0 flex-1 space-y-1 text-sm [overflow-wrap:anywhere]">
          <p className="font-medium">{image.filename}</p>
          {image.caption ? <p className="whitespace-pre-wrap">{image.caption}</p> : null}
          <p className="text-xs text-grey-500">
            {image.uploader_name || 'Unknown user'} · {image.source === 'agent' ? 'Agent upload' : 'User upload'} · <RelativeTime iso={image.created_at} />
          </p>
          <p className="text-xs text-grey-500">{image.width} × {image.height} · {new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(image.byte_size / 1024)} KB · {image.content_type}</p>
          <div ref={trigger} className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-xs">
            {content ? <a href={content} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center underline">Open full image<span className="sr-only">: {image.filename} (new tab)</span></a> : null}
            {download ? <a href={download} download={image.filename} className="inline-flex min-h-9 items-center underline">Download<span className="sr-only">: {image.filename}</span></a> : null}
            {canDelete && !confirming ? <Button variant="ghost" aria-label={`Delete image: ${image.filename}`} aria-controls={confirmationId} onClick={() => { removal.reset(); setConfirming(true) }}>Delete</Button> : null}
          </div>
          {canDelete && confirming ? (
            <div id={confirmationId} className="border-l-2 border-blocked pl-3" onKeyDown={(event) => { if (event.key === 'Escape' && !removal.isPending) closeConfirmation() }}>
              <p>Delete this image permanently? This cannot be undone.</p>
              {removal.error ? <p role="alert" className="mt-1 text-blocked">Could not delete image. Try again.</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="danger" disabled={removal.isPending} onClick={() => removal.mutate()}>{removal.isPending ? 'Deleting…' : 'Delete image'}</Button>
                <Button autoFocus disabled={removal.isPending} onClick={closeConfirmation}>Cancel</Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  )
}

export function ImagesSection({ slug, target, targetId }: { slug: string; target: 'issues' | 'milestones'; targetId: string }) {
  const client = useQueryClient()
  const { user, workspace } = useSession(slug)
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [announcement, setAnnouncement] = useState('')
  const queryKey = ['images', slug, target, targetId]
  const images = useQuery({
    queryKey,
    queryFn: () => api.get<{ images: ImageAttachment[] }>(`/w/${encodeURIComponent(slug)}/${target}/${encodeURIComponent(targetId)}/images`),
  })

  async function remove(image: ImageAttachment) {
    await api.del(`/w/${encodeURIComponent(slug)}/images/${encodeURIComponent(image.id)}`)
    client.setQueryData<{ images: ImageAttachment[] }>(queryKey, (current) => current ? { images: current.images.filter((item) => item.id !== image.id) } : current)
    void client.invalidateQueries({ queryKey })
    void client.invalidateQueries({ queryKey: ['activity', slug] })
    setAnnouncement(`Deleted image: ${image.filename}`)
    heading.current?.focus()
  }

  return (
    <section aria-labelledby={headingId} data-testid="image-section" className="min-w-0">
      <h2 ref={heading} tabIndex={-1} id={headingId} className="mb-2 text-xs tracking-wide text-grey-500 uppercase">Images</h2>
      <p role="status" className="sr-only">{announcement}</p>
      {images.isPending ? <LoadingState label="Loading images…" /> : images.error ? (
        <ErrorState message="Could not load images." onRetry={() => void images.refetch()} retrying={images.isRefetching} />
      ) : images.data?.images.length ? (
        <ul className="min-w-0 divide-y divide-grey-200 border-y border-grey-200">
          {images.data.images.map((image) => <ImageRow key={image.id} image={image} slug={slug} canDelete={Boolean(user && workspace && (workspace.role === 'admin' || (workspace.role === 'member' && image.uploader_id === user.id)))} onDelete={() => remove(image)} />)}
        </ul>
      ) : <EmptyState title="No images yet." message="Ask your agent to attach an image with context for this work." />}
    </section>
  )
}
