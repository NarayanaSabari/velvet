import { useState } from 'react'

import { ImageViewer, type ImageAttachment } from './ImagesSection'
import { protectedImageUrl } from './protectedImageUrl'

/** Screenshots attached to one comment, shown under its text. */
export function CommentImages({ images, slug }: { images?: ImageAttachment[]; slug: string }) {
  const [viewing, setViewing] = useState<string | null>(null)
  if (!images?.length) return null
  return (
    <>
      <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attached images">
        {images.map((image) => <CommentImage key={image.id} image={image} slug={slug} onView={() => setViewing(image.id)} />)}
      </ul>
      <ImageViewer images={images} slug={slug} openId={viewing} onClose={() => setViewing(null)} />
    </>
  )
}

function CommentImage({ image, slug, onView }: { image: ImageAttachment; slug: string; onView: () => void }) {
  const [broken, setBroken] = useState(false)
  const src = protectedImageUrl(image.content_url, slug, image.id, 'content')
  const alt = image.caption || image.filename
  return (
    <li className="w-full max-w-60" data-testid={`comment-image-${image.id}`}>
      {src && !broken ? (
        <button type="button" onClick={onView} className="block w-full cursor-zoom-in overflow-hidden rounded-[var(--radius-control)] border border-grey-200 bg-grey-100" aria-label={`View image: ${alt}`}>
          <img src={src} alt={alt} loading="lazy" width={image.width} height={image.height} className="h-auto max-h-60 w-full object-contain" onError={() => setBroken(true)} />
        </button>
      ) : <p className="rounded-[var(--radius-control)] border border-grey-200 px-3 py-6 text-xs text-grey-700">Image preview unavailable.</p>}
      {image.caption ? <p className="mt-1 text-xs text-grey-700 [overflow-wrap:anywhere]">{image.caption}</p> : null}
    </li>
  )
}
