import type { ReactNode } from 'react'

import { NavLink } from '../../app/nav'
import { buttonClassName } from '../../ui/buttonStyles'

const SOURCE_URL = 'https://github.com/NarayanaSabari/velvet-otter-lab'

function LedgerMark({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 7.5H18M6 12H14M6 16.5H18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="16" y="10" width="2" height="2" rx="1" fill="currentColor" />
    </svg>
  )
}

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-semibold tracking-[-0.02em]">
      <LedgerMark className="size-6" />
      Velvet
    </span>
  )
}

function WorkRow({
  kind,
  project,
  issue,
  source,
  children,
}: {
  kind: string
  project: string
  issue?: string
  source?: string
  children: ReactNode
}) {
  return (
    <li className="py-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-grey-500">
        <span>{kind}</span>
        <span>{project}</span>
        {issue ? <span className="font-mono text-ink">{issue}</span> : null}
        {source ? <span>{source}</span> : null}
      </div>
      <p className="mt-1 min-w-0 break-words text-sm text-ink">{children}</p>
    </li>
  )
}

function WorkLedger() {
  return (
    <section
      aria-labelledby="ledger-title"
      aria-describedby="ledger-description"
      className="border-y border-grey-200 bg-paper"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-grey-200 py-3">
        <h2 id="ledger-title" className="text-sm font-medium">Monday, September 21</h2>
        <p id="ledger-description" className="text-xs text-grey-500">Sample work log</p>
      </div>

      <div className="py-4">
        <h3 className="text-xs font-medium text-grey-700">Client</h3>
        <ul className="divide-y divide-grey-200 border-b border-grey-200">
          <WorkRow kind="Note" project="portal" source="agent">
            Rebuilt the invoice export and recorded the migration decision.
          </WorkRow>
        </ul>
      </div>

      <div className="pb-4">
        <h3 className="text-xs font-medium text-grey-700">Lab</h3>
        <ul className="divide-y divide-grey-200 border-b border-grey-200">
          <WorkRow kind="Ticket" project="velvet" issue="ENG-142">
            Cache the resolved workspace lookup
          </WorkRow>
          <WorkRow kind="Pull request" project="velvet" issue="ENG-142">
            acme/widgets#77 · open
          </WorkRow>
          <WorkRow kind="Note" project="velvet" source="agent">
            Stopped resolving the same repository on every CLI call.
          </WorkRow>
        </ul>
      </div>

      <p className="border-t border-grey-200 py-3 text-xs text-grey-500">
        GitHub is evidence. You decide when the work is done.
      </p>
    </section>
  )
}

const MODEL = [
  ['Project', 'The durable body of work, carried across many sprints.'],
  ['Sprint', 'The calendar window that says when work is happening.'],
  ['Milestone', 'A concrete goal inside one sprint.'],
  ['Issue', 'The work itself, filed now or organised later.'],
] as const

export function LandingPage() {
  return (
    <div className="h-dvh snap-y snap-mandatory overflow-y-auto overscroll-y-contain bg-paper text-ink motion-reduce:scroll-auto">
      <a
        href="#main-content"
        className="sr-only left-3 top-3 z-50 bg-paper px-3 py-2 text-sm focus:not-sr-only focus:fixed"
      >
        Skip to content
      </a>

      <header className="fixed inset-x-0 top-0 z-40 border-b border-grey-200 bg-paper">
        <div className="mx-auto flex max-w-[80rem] items-center justify-between gap-4 px-3 py-4 sm:px-4">
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

      <main id="main-content">
        <section className="mx-auto grid min-h-dvh max-w-[80rem] snap-start scroll-mt-20 content-center gap-8 border-b border-grey-200 px-3 pb-16 pt-28 sm:px-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(25rem,0.9fr)] lg:items-center lg:gap-16 lg:pb-20 lg:pt-32">
          <div className="min-w-0">
            <h1 className="max-w-[11ch] text-display font-semibold">
              Know what you worked on last week.
            </h1>
          </div>
          <div className="min-w-0">
            <p className="mt-6 max-w-[38rem] text-sm text-grey-700 sm:text-base">
              Velvet keeps project notes, tickets, pull requests, commits, and agent-written progress in one self-hosted record of your work across every organisation you belong to.
            </p>
            <div className="mt-8 flex flex-wrap gap-2">
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
            <p className="mt-4 text-xs text-grey-500">
              No estimates. No time tracking. No automatic status changes from GitHub.
            </p>
          </div>
        </section>

        <section className="mx-auto grid min-h-dvh max-w-[80rem] snap-start scroll-mt-20 content-center gap-8 border-b border-grey-200 px-3 pb-16 pt-28 sm:px-4 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-center lg:gap-16 lg:pb-20 lg:pt-32">
          <div>
            <h2 className="text-lg font-medium tracking-[-0.025em]">A week, reconstructed.</h2>
            <p className="mt-4 max-w-[24rem] text-sm text-grey-500">
              Notes, tickets, pull requests, and agent progress stay together in the order the work happened.
            </p>
          </div>
          <div className="min-w-0">
            <WorkLedger />
          </div>
        </section>

        <section className="mx-auto grid min-h-dvh max-w-[80rem] snap-start scroll-mt-20 content-center gap-8 border-b border-grey-200 px-3 pb-16 pt-28 sm:px-4 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-16 lg:pb-20 lg:pt-32">
          <h2 className="text-lg font-medium tracking-[-0.025em]">
            Work gets logged before it disappears.
          </h2>
          <div className="min-w-0">
            <p className="max-w-[46rem] text-sm text-grey-700 sm:text-base">
              An agent can write progress against the project it is actually working in, even when no ticket key exists. Useful work does not vanish because the filing came late.
            </p>
            <div className="mt-8 overflow-x-auto border-y border-grey-200 bg-grey-100 px-3 py-2 font-mono text-xs sm:px-4">
              <p className="whitespace-nowrap">velvet log "Fixed the dropped retry."</p>
              <p className="mt-2 whitespace-nowrap">velvet attach ENG-142 acme/widgets#77</p>
              <p className="mt-2 whitespace-nowrap">velvet recap --days 7</p>
            </div>
          </div>
        </section>

        <section className="mx-auto grid min-h-dvh max-w-[80rem] snap-start scroll-mt-20 content-center gap-8 border-b border-grey-200 px-3 pb-16 pt-28 sm:px-4 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-16 lg:pb-20 lg:pt-32">
          <h2 className="text-lg font-medium tracking-[-0.025em]">
            Organise the work without confusing the clocks.
          </h2>
          <div className="min-w-0">
            <p className="max-w-[46rem] text-sm text-grey-700 sm:text-base">
              Projects preserve the long thread. Sprints and milestones describe the current window. Issues carry the concrete work.
            </p>
            <dl className="mt-8 border-y border-grey-200">
              {MODEL.map(([term, description]) => (
                <div
                  key={term}
                  className="grid gap-1 border-b border-grey-200 py-3 last:border-b-0 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-6"
                >
                  <dt className="text-sm font-medium">{term}</dt>
                  <dd className="text-sm text-grey-500">{description}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="mx-auto grid min-h-dvh max-w-[80rem] snap-start scroll-mt-20 content-center gap-8 border-b border-grey-200 px-3 pb-16 pt-28 sm:px-4 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-16 lg:pb-20 lg:pt-32">
          <h2 className="text-lg font-medium tracking-[-0.025em]">
            GitHub proves the work. It does not run the workflow.
          </h2>
          <div className="min-w-0">
            <p className="max-w-[46rem] text-sm text-grey-700 sm:text-base">
              Pull requests and commits attach as evidence. A merge never marks a ticket done. Velvet asks; a person decides.
            </p>
            <div className="mt-8 border-l-2 border-ink pl-4">
              <p className="text-sm font-medium">PR merged. Is ENG-142 done?</p>
              <p className="mt-1 text-xs text-grey-500">A prompt, never a transition.</p>
            </div>
          </div>
        </section>

        <section className="flex min-h-dvh snap-start scroll-mt-20 flex-col pt-20">
          <div className="mx-auto flex w-full max-w-[80rem] flex-1 items-center px-3 py-12 sm:px-4 lg:py-20">
            <div className="grid w-full gap-8 bg-ink px-4 py-10 text-paper sm:px-6 sm:py-14 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:gap-16 lg:px-8 lg:py-16">
              <div>
                <h2 className="max-w-[22ch] text-lg font-medium tracking-[-0.025em]">
                  Keep the record where the work belongs: with you.
                </h2>
                <p className="mt-3 max-w-[46rem] text-sm text-paper/75">
                  Velvet is self-hosted. Your team owns the data, and GitHub access stays read-only.
                </p>
              </div>
              <NavLink
                to="/signin"
                className="ui-button inline-flex min-h-11 w-fit items-center rounded-[6px] border border-paper bg-paper px-4 text-sm text-ink no-underline hover:opacity-90"
              >
                Sign in
              </NavLink>
            </div>
          </div>
          <footer className="mx-auto flex w-full max-w-[80rem] flex-wrap items-center justify-between gap-4 border-t border-grey-200 px-3 py-6 text-xs text-grey-500 sm:px-4">
            <Wordmark />
            <p>Self-hosted work records for people and agents.</p>
          </footer>
        </section>
      </main>
    </div>
  )
}
