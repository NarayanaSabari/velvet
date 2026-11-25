import type { ReactNode } from 'react'
import { Banner } from '@astryxdesign/core/Banner'

/**
 * How the app says something went wrong: one Astryx error banner, announced
 * as an alert. With only a message it is a single line. With a `title` the
 * title says what happened and the message says what to do about it.
 */
export function ErrorNote({ title, children, action, className }: {
  title?: ReactNode
  children?: ReactNode
  /** A way to recover, such as a retry button, at the end of the banner. */
  action?: ReactNode
  /** Spacing around the note, where the layout needs it. */
  className?: string
}) {
  return (
    <div role="alert" className={className}>
      <Banner
        status="error"
        title={title ?? children}
        description={title ? children : undefined}
        endContent={action}
        collapsible={false}
      />
    </div>
  )
}
