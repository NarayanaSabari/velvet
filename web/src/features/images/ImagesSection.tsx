import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Heading } from '@astryxdesign/core/Heading'
import { Lightbox } from '@astryxdesign/core/Lightbox'
import { Link } from '@astryxdesign/core/Link'
import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'

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

/**
 * The full-size viewer for a set of images. Only images whose address passes
 * the protected-URL check are shown, the same rule the thumbnails follow.
 */
export function ImageViewer({ images, slug, openId, onClose }: {
  images: ImageAttachment[]
  slug: string
  openId: string | null
  onClose: () => void
}) {
  const [index, setIndex] = useState(0)
  const [shownFor, setShownFor] = useState<string | null>(null)
  const media = images.flatMap((image) => {
    const src = protectedImageUrl(image.content_url, slug, image.id, 'content')
    return src ? [{ id: image.id, src, alt: image.caption || image.filename,
      // A caption that only repeats the file name says nothing over the picture.
      caption: image.caption && image.caption !== image.filename ? image.caption : undefined,
    }] : []
  })
  // Start on the image that was pressed each time the viewer opens.
  if (openId !== shownFor) {
    setShownFor(openId)
    if (openId) setIndex(Math.max(0, media.findIndex((item) => item.id === openId)))
  }
  // Mounted only while open, so a closed viewer adds nothing to the page.
  if (media.length === 0 || openId === null) return null
  return (
    <Lightbox
      isOpen
      onOpenChange={(open) => { if (!open) onClose() }}
      media={media.map(({ src, alt, caption }) => ({ src, alt, caption }))}
      index={Math.min(index, media.length - 1)}
      onIndexChange={setIndex}
      hasZoom
    />
  )
}

function ImageRow({ image, slug, canDelete, onDelete, onView }: {
  image: ImageAttachment
  slug: string
  canDelete: boolean
  onDelete: () => Promise<void>
  onView: () => void
}) {
  const [broken, setBroken] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const trigger = useRef<HTMLDivElement>(null)
  const wasConfirming = useRef(false)
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

  const size = `${image.width} × ${image.height} · ${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(image.byte_size / 1024)} KB · ${image.content_type}`

  return (
    <ListItem
      itemKey={image.id}
      data-testid={`image-item-${image.id}`}
      align="start"
      startContent={(
        <div className="flex h-24 w-32 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] border border-grey-200 bg-grey-100">
          {content && !broken ? (
            <button type="button" onClick={onView} className="flex h-full w-full cursor-zoom-in items-center justify-center" aria-label={`View image: ${image.filename}`}>
              <img src={content} alt={image.caption || image.filename} loading="lazy" className="max-h-full max-w-full object-contain" onError={() => setBroken(true)} />
            </button>
          ) : <Text type="supporting" color="secondary" className="px-3">Image preview unavailable.</Text>}
        </div>
      )}
      label={<Text weight="medium" className="[overflow-wrap:anywhere]">{image.filename}</Text>}
      description={(
        <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
          {image.caption ? <Text as="p" display="block" className="whitespace-pre-wrap">{image.caption}</Text> : null}
          <Text as="p" display="block" type="supporting" color="secondary">
            {image.uploader_name || 'Unknown user'} · {image.source === 'agent' ? 'Agent upload' : 'User upload'} · <RelativeTime iso={image.created_at} />
          </Text>
          <Text as="p" display="block" type="supporting" color="secondary">{size}</Text>
          <div ref={trigger} className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
            {content ? <Link href={content} target="_blank" rel="noopener noreferrer" className="underline">Open in new tab<span className="sr-only">: {image.filename}</span></Link> : null}
            {download ? <Link href={download} download={image.filename} className="underline">Download<span className="sr-only">: {image.filename}</span></Link> : null}
            {canDelete ? <Button variant="ghost" aria-label={`Delete image: ${image.filename}`} aria-haspopup="dialog" onClick={() => { removal.reset(); setConfirming(true) }}>Delete</Button> : null}
          </div>
          {canDelete ? (
            <ConfirmDialog
              open={confirming}
              onClose={closeConfirmation}
              title="Delete this image?"
              description={`${image.filename} will be deleted permanently. This cannot be undone.`}
              actionLabel="Delete image"
              pending={removal.isPending}
              error={removal.error ? 'Could not delete image. Try again.' : null}
              onConfirm={() => removal.mutate()}
            />
          ) : null}
        </div>
      )}
    />
  )
}

export function ImagesSection({ slug, target, targetId }: { slug: string; target: 'issues' | 'milestones'; targetId: string }) {
  const client = useQueryClient()
  const { user, workspace } = useSession(slug)
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [announcement, setAnnouncement] = useState('')
  const [viewing, setViewing] = useState<string | null>(null)
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
      <Heading level={4} accessibilityLevel={2} ref={heading} tabIndex={-1} id={headingId} className="mb-2">Images</Heading>
      <p role="status" className="sr-only">{announcement}</p>
      {images.isPending ? <LoadingState label="Loading images…" /> : images.error ? (
        <ErrorState message="Could not load images." onRetry={() => void images.refetch()} retrying={images.isRefetching} />
      ) : images.data?.images.length ? (
        <List hasDividers density="balanced" edge="flush" aria-label="Images">
          {images.data.images.map((image) => <ImageRow key={image.id} image={image} slug={slug} canDelete={Boolean(user && workspace && (workspace.role === 'admin' || (workspace.role === 'member' && image.uploader_id === user.id)))} onDelete={() => remove(image)} onView={() => setViewing(image.id)} />)}
        </List>
      ) : <EmptyState compact title="No images yet." message="Ask your agent to attach an image with context for this work." />}
      <ImageViewer images={images.data?.images ?? []} slug={slug} openId={viewing} onClose={() => setViewing(null)} />
    </section>
  )
}
