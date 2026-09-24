import type { ReactNode } from 'react'

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
        {eyebrow ? <p className="mb-1 text-xs text-grey-500">{eyebrow}</p> : null}
        <h1 className="text-lg font-medium tracking-[-0.02em] [overflow-wrap:anywhere]">{title}</h1>
        {description ? <p className="mt-1 max-w-[46rem] text-sm text-grey-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </header>
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
        <h2 id={id} className="text-sm font-medium text-ink">{title}</h2>
        {meta ? <span className="text-xs text-grey-500">{meta}</span> : null}
      </div>
      {action ? <div className="text-sm">{action}</div> : null}
    </div>
  )
}
