import { useState } from 'react'

import type { ImageAttachment } from './ImagesSection'
import { protectedImageUrl } from './protectedImageUrl'

/** Screenshots attached to one comment, shown under its text. */
export function CommentImages({ images, slug }: { images?: ImageAttachment[]; slug: string }) {
  if (!images?.length) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attached images">
      {images.map((image) => <CommentImage key={image.id} image={image} slug={slug} />)}
    </ul>
  )
}

function CommentImage({ image, slug }: { image: ImageAttachment; slug: string }) {
  const [broken, setBroken] = useState(false)
  const src = protectedImageUrl(image.content_url, slug, image.id, 'content')
  const alt = image.caption || image.filename
  return (
    <li className="w-full max-w-60" data-testid={`comment-image-${image.id}`}>
      {src && !broken ? (
        <a href={src} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-[var(--radius-control)] border border-grey-200 bg-grey-100" aria-label={`Open full image: ${alt} (new tab)`}>
          <img src={src} alt={alt} loading="lazy" width={image.width} height={image.height} className="h-auto w-full object-contain" onError={() => setBroken(true)} />
        </a>
      ) : <p className="rounded-[var(--radius-control)] border border-grey-200 px-3 py-6 text-xs text-grey-700">Image preview unavailable.</p>}
      {image.caption ? <p className="mt-1 text-xs text-grey-700 [overflow-wrap:anywhere]">{image.caption}</p> : null}
    </li>
  )
}
