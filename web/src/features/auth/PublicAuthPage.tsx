import { useId, type ReactNode } from 'react'
import { PublicPageLayout } from '../landing/PublicPageLayout'

export function PublicAuthPage({ title, children, note = 'No password needed', expanded = false }: {
  title: string
  children: ReactNode
  note?: string
  expanded?: boolean
}) {
  const headingId = useId()
  return (
    <PublicPageLayout signingIn title={title} expanded={expanded}>
      <section aria-labelledby={headingId} className="landing-signin">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-grey-200 pb-4">
          <h1 id={headingId} className="text-lg font-medium tracking-[-0.02em]">{title}</h1>
          {note ? <p className="text-xs text-grey-500">{note}</p> : null}
        </div>
        <div className="landing-signin-form">{children}</div>
      </section>
    </PublicPageLayout>
  )
}
