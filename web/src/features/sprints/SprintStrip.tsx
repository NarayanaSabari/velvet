import { Text } from '@astryxdesign/core/Text'
import type { ReactNode } from 'react'

import { NavLink } from '../../app/nav'
import { formatDay, stateLabel } from '../../lib/formatDate'
import type { Sprint, SprintState } from '../../lib/types'
import { dayNumber, todayNumber } from './sprintDays'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// State is drawn by shape as well as fill, and named in the key and in each
// bar's link, so it never rests on colour alone: a solid ink bar is running
// now, a dashed outline has not started, a quiet grey bar is finished.
const BAR: Record<SprintState, string> = {
  active: 'border-ink bg-ink text-paper',
  upcoming: 'border-dashed border-grey-500 bg-transparent text-ink',
  completed: 'border-grey-200 bg-grey-200 text-ink',
}

export interface StripRow {
  id: string
  /** Names the row for assistive technology and for tests. */
  name: string
  testId?: string
  sprints: Sprint[]
}

/** The first day of each month that falls inside the span, for the axis. */
function monthTicks(first: number, last: number): Array<{ day: number; label: string }> {
  const ticks: Array<{ day: number; label: string }> = []
  const start = new Date(first * 864e5)
  let year = start.getUTCFullYear()
  let month = start.getUTCMonth()
  for (;;) {
    const day = Math.floor(Date.UTC(year, month, 1) / 864e5)
    if (day > last) break
    if (day >= first) ticks.push({ day, label: `${MONTHS[month]} ${year}` })
    month += 1
    if (month > 11) { month = 0; year += 1 }
  }
  return ticks
}

export function StripKey() {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1" aria-label="What the bars mean">
      {(['active', 'upcoming', 'completed'] as const).map((state) => (
        <li key={state} className="flex items-center gap-2">
          <span className={`inline-block h-3 w-6 rounded-[3px] border ${BAR[state]}`} aria-hidden="true" />
          <Text type="supporting" color="secondary">{stateLabel(state)}</Text>
        </li>
      ))}
      <li className="flex items-center gap-2">
        <span className="inline-block h-4 w-px bg-stale" aria-hidden="true" />
        <Text type="supporting" color="secondary">Today</Text>
      </li>
    </ul>
  )
}

/**
 * Sprints on one shared calendar, a row per project, so overlaps and gaps
 * between projects can be read straight across. `lead` is what sits at the
 * start of each row. Each bar is a link to its sprint.
 */
export function SprintStrip({ rows, slug, lead, leadWidth = '12rem' }: {
  rows: StripRow[]
  slug: string
  lead: (row: StripRow) => ReactNode
  leadWidth?: string
}) {
  const sprints = rows.flatMap((row) => row.sprints)
  if (sprints.length === 0) return null
  const first = Math.min(...sprints.map((sprint) => dayNumber(sprint.starts_on)))
  const last = Math.max(...sprints.map((sprint) => dayNumber(sprint.ends_on))) + 1
  const span = Math.max(last - first, 1)
  const today = todayNumber()
  const at = (day: number) => `${((day - first) / span) * 100}%`
  const ticks = monthTicks(first, last)

  function bar(sprint: Sprint) {
    const start = dayNumber(sprint.starts_on)
    const end = dayNumber(sprint.ends_on) + 1
    const dates = `${formatDay(sprint.starts_on)} to ${formatDay(sprint.ends_on)}`
    return (
      <li
        key={sprint.id}
        className="absolute top-1.5 bottom-1.5 px-px"
        style={{ left: at(start), width: `${((end - start) / span) * 100}%` }}
      >
        {/* The bar is the link, as wide as the sprint is long. */}
        <NavLink
          to={`/w/${slug}/sprints/${sprint.id}`}
          current={false}
          attributes={{ title: `${sprint.name}, ${dates}, ${stateLabel(sprint.state)}` }}
          className={`flex h-7 min-w-0 items-center rounded-[4px] border px-2 text-xs font-medium no-underline hover:opacity-80 ${BAR[sprint.state]}`}
        >
          <span className="truncate">{sprint.name}</span>
          {/* Read out with the name: the bar's place and fill say this only to the eye. */}
          <span className="sr-only">, <time dateTime={sprint.starts_on}>{formatDay(sprint.starts_on)}</time> to <time dateTime={sprint.ends_on}>{formatDay(sprint.ends_on)}</time>, {stateLabel(sprint.state)}</span>
        </NavLink>
      </li>
    )
  }

  return (
    <div className="min-w-0" data-testid="sprint-strip">
      <div className="grid items-end" style={{ gridTemplateColumns: `${leadWidth} minmax(0, 1fr)` }}>
        <span />
        <div className="relative h-6 border-b border-grey-200" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.day} className="absolute bottom-1 -translate-x-px border-l border-grey-300 pl-1.5 text-xs whitespace-nowrap text-grey-500" style={{ left: at(tick.day) }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <div className="divide-y divide-grey-200 border-b border-grey-200">
        {rows.map((row) => (
          <section
            key={row.id}
            aria-label={row.name}
            className="grid items-center"
            style={{ gridTemplateColumns: `${leadWidth} minmax(0, 1fr)` }}
            data-testid={row.testId}
          >
            <div className="min-w-0 py-2 pr-4">{lead(row)}</div>
            <div className="relative h-10">
              {ticks.map((tick) => (
                <span key={tick.day} className="absolute inset-y-0 border-l border-grey-200" style={{ left: at(tick.day) }} aria-hidden="true" />
              ))}
              <ul aria-label={`${row.name} sprints`}>
                {row.sprints.map(bar)}
              </ul>
              {today >= first && today <= last ? (
                <span className="pointer-events-none absolute inset-y-0 w-px bg-stale" style={{ left: at(today + 0.5) }} aria-hidden="true" />
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
