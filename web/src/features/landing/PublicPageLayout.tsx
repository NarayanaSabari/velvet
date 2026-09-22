import { useEffect, type ReactNode } from 'react'

import { NavLink } from '../../app/nav'
import { buttonClassName } from '../../ui/buttonStyles'
import { Wordmark } from '../../ui/Wordmark'
import './landing.css'

const SOURCE_URL = 'https://github.com/NarayanaSabari/velvet-otter-lab'

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

export function PublicPageLayout({ children, signingIn = false, title = 'Know what you worked on', expanded = false }: {
  children: ReactNode
  signingIn?: boolean
  title?: string
  expanded?: boolean
}) {
  const Headline = signingIn ? 'p' : 'h1'
  useEffect(() => {
    const previousTitle = document.title
    document.title = `${title} · Velvet`
    return () => { document.title = previousTitle }
  }, [title])

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
          <NavLink to="/" className="inline-flex min-h-11 items-center rounded-[6px]">
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
              to={signingIn ? '/' : '/signin'}
              className={buttonClassName('primary', 'inline-flex min-h-11 items-center px-4 no-underline')}
            >
              {signingIn ? 'About Velvet' : 'Sign in'}
            </NavLink>
          </nav>
        </div>
      </header>

      <main
        id="main-content"
        className={`landing-layout${expanded ? ' landing-layout-expanded' : ''}`}
      >
        <section className="landing-intro">
          <div className="min-w-0">
            <Headline className="landing-title font-semibold">
              Know what you worked on last week.
            </Headline>
            <p className="landing-description text-xs text-grey-700 lg:text-base">
              Your notes, tickets, and agent progress. GitHub proof. One work record across organisations.
            </p>
            <div className="landing-actions mt-4 hidden flex-wrap gap-2 sm:flex lg:mt-6">
              <NavLink
                to={signingIn ? '/' : '/signin'}
                className={buttonClassName('primary', 'inline-flex min-h-11 items-center px-4 no-underline')}
              >
                {signingIn ? 'About Velvet' : 'Sign in'}
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

        {children}

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
