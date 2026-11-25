import type { ReactNode, Ref } from 'react'
import { Heading } from './Heading'
import { Text } from '@astryxdesign/core/Text'

/** A page's title block. The type is Astryx's; the layout is Velvet's. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-grey-200 pb-4">
      <div className="min-w-0 flex-1">
        {eyebrow ? <Text as="p" type="supporting" color="secondary" display="block" className="mb-1">{eyebrow}</Text> : null}
        <Heading level={1} wordBreak="break-word">{title}</Heading>
        {description ? (
          <Text as="p" color="secondary" display="block" className="mt-1 max-w-[46rem]">{description}</Text>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </header>
  )
}

/**
 * A quiet section title for side panels and the parts of a detail page.
 * It is a second-level heading in the page outline, drawn two steps smaller.
 */
export function PanelHeading({
  children,
  id,
  className = 'mb-2',
  ref,
}: {
  children: ReactNode
  id?: string
  className?: string
  ref?: Ref<HTMLHeadingElement>
}) {
  return (
    <Heading level={4} accessibilityLevel={2} id={id} className={className} ref={ref}>
      {children}
    </Heading>
  )
}

export function SectionHeader({
  title,
  meta,
  action,
  id,
}: {
  title: ReactNode
  meta?: ReactNode
  action?: ReactNode
  id?: string
}) {
  return (
    <div className="mb-2 flex min-h-8 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-grey-200 pb-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <Heading level={2} id={id}>{title}</Heading>
        {meta ? <Text type="supporting" color="secondary">{meta}</Text> : null}
      </div>
      {action ? <div className="text-sm">{action}</div> : null}
    </div>
  )
}
