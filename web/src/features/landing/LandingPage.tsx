import type { ReactNode } from 'react'

import { NavLink } from '../../app/nav'
import { buttonClassName } from '../../ui/buttonStyles'
import { Wordmark } from '../../ui/Wordmark'
import './landing.css'

const SOURCE_URL = 'https://github.com/NarayanaSabari/velvet-otter-lab'

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

const PROOFS = [
  {
    title: 'Agents can log first.',
    body: <>Log project progress, with or without a ticket.</>,
  },
  {
    title: 'Projects last.',
    body: <>Sprints set time. Milestones set goals. Issues hold the work.</>,
  },
  {
    title: 'GitHub proves the work.',
    body: <>PRs and commits are proof. You decide when work is done.</>,
  },
  {
    title: 'The record stays yours.',
    body: <>Self-hosted data. Read-only GitHub access.</>,
  },
] as const

export function LandingPage() {
  return (
    <div className="landing-canvas bg-paper text-ink">
      <a
        href="#main-content"
        className="sr-only left-3 top-3 z-50 bg-paper px-3 py-2 text-sm focus:not-sr-only focus:fixed"
      >
        Skip to content
      </a>

      <header className="h-[68px] border-b border-grey-200">
        <div className="flex h-full items-center justify-between gap-3 px-3 sm:px-6">
          <NavLink to="/" className="rounded-[6px]">
            <Wordmark />
          </NavLink>
          <nav aria-label="Public navigation" className="flex items-center gap-1 sm:gap-2">
            <a
              className={buttonClassName('ghost', 'inline-flex min-h-11 items-center px-3 no-underline')}
              href={SOURCE_URL}
              target="_blank"
              rel="noreferrer"
            >
              View source
            </a>
            <NavLink
              to="/signin"
              className={buttonClassName('primary', 'inline-flex min-h-11 items-center px-4 no-underline')}
            >
              Sign in
            </NavLink>
          </nav>
        </div>
      </header>

      <main
        id="main-content"
        className="landing-layout"
      >
        <section className="landing-intro">
          <div className="min-w-0">
            <h1 className="landing-title font-semibold">
              Know what you worked on last week.
            </h1>
            <p className="landing-description text-xs text-grey-700 lg:text-base">
              Your notes, tickets, and agent progress. GitHub proof. One work record across organisations.
            </p>
            <div className="mt-4 hidden flex-wrap gap-2 sm:flex lg:mt-6">
              <NavLink
                to="/signin"
                className={buttonClassName('primary', 'inline-flex min-h-11 items-center px-4 no-underline')}
              >
                Sign in
              </NavLink>
              <a
                className={buttonClassName('secondary', 'inline-flex min-h-11 items-center px-4 no-underline')}
                href={SOURCE_URL}
                target="_blank"
                rel="noreferrer"
              >
                View source
              </a>
            </div>
            <p className="mt-2 text-xs text-grey-500 lg:mt-3">
              No estimates. No time tracking.
            </p>
          </div>
          <div className="landing-project">
            <h2 className="text-lg font-medium">One project. A lasting record.</h2>
            <dl className="mt-4 divide-y divide-grey-200 border-y border-grey-200">
              {[
                ['Project', 'The long-running body of work'],
                ['Sprint', 'The current time window'],
                ['Milestone', 'A goal within the sprint'],
                ['Issue', 'The concrete work to do'],
              ].map(([term, definition]) => (
                <div key={term} className="grid grid-cols-[6rem_1fr] gap-2 py-3 text-xs">
                  <dt className="font-medium">{term}</dt>
                  <dd className="text-grey-500">{definition}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 font-mono text-xs text-grey-700">velvet recap --days 7</p>
          </div>
        </section>

        <WorkLedger />

        <section aria-label="How Velvet works" className="landing-proofs">
          {PROOFS.map((proof) => (
            <article
              key={proof.title}
              className="min-w-0"
            >
              <h2 className="text-xs font-medium lg:text-lg">{proof.title}</h2>
              <p className="mt-1 text-xs text-grey-500 lg:mt-3 lg:text-sm">{proof.body}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  )
}
