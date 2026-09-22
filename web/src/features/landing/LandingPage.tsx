import type { ReactNode } from 'react'

import { PublicPageLayout } from './PublicPageLayout'

function WorkRow({ meta, children }: { meta: ReactNode; children: ReactNode }) {
  return (
    <li className="landing-work-row">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-grey-500">
        {meta}
      </div>
      <p className="min-w-0 text-xs text-ink lg:text-sm">{children}</p>
    </li>
  )
}

function WorkLedger() {
  return (
    <section aria-labelledby="ledger-title" className="landing-ledger">
      <div className="flex items-baseline justify-between gap-2 border-b border-grey-200 py-2">
        <h2 id="ledger-title" className="text-xs font-medium sm:text-sm">Monday, September 21</h2>
        <p className="text-xs text-grey-500">Sample work log</p>
      </div>

      <div className="landing-client border-b border-grey-200">
        <p className="text-xs font-medium text-grey-700">Client</p>
        <ul>
          <WorkRow meta={<><span>Note</span><span>portal</span><span>agent</span></>}>
            Rebuilt the invoice export.
          </WorkRow>
        </ul>
      </div>

      <div className="landing-lab">
        <p className="text-xs font-medium text-grey-700">Lab</p>
        <ul className="divide-y divide-grey-200">
          <WorkRow meta={<><span>Ticket</span><span>velvet</span><span className="font-mono text-ink">ENG-142</span></>}>
            Cache the workspace lookup
          </WorkRow>
          <WorkRow meta={<><span>PR</span><span>velvet</span><span className="font-mono text-ink">#77</span></>}>
            acme/widgets · open
          </WorkRow>
          <WorkRow meta={<><span>Note</span><span>velvet</span><span>agent</span></>}>
            Removed repeat repository lookups.
          </WorkRow>
        </ul>
      </div>
    </section>
  )
}

export function LandingPage() {
  return <PublicPageLayout><WorkLedger /></PublicPageLayout>
}
