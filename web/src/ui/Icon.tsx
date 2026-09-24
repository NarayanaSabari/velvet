import type { ReactNode } from 'react'

/**
 * A small inline icon set drawn on a 16px grid with a 1.5px stroke, so icons
 * inherit the surrounding text colour and stay inside the monochrome palette
 * without adding an icon dependency.
 */
const PATHS = {
  dashboard: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1.25" />
      <rect x="9" y="2" width="5" height="5" rx="1.25" />
      <rect x="2" y="9" width="5" height="5" rx="1.25" />
      <rect x="9" y="9" width="5" height="5" rx="1.25" />
    </>
  ),
  issues: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none" />
    </>
  ),
  projects: <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" />,
  sprints: (
    <>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </>
  ),
  reports: <path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" />,
  admin: (
    <>
      <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
      <circle cx="10" cy="4.5" r="1.5" />
      <circle cx="6" cy="11.5" r="1.5" />
    </>
  ),
  feed: <path d="M1.5 8h2.75L6 3.5l4 9 1.75-4.5h2.75" />,
  mentions: (
    <>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M10.6 5.4v3.3a1.95 1.95 0 0 0 3.9 0V8a6.5 6.5 0 1 0-2.6 5.2" />
    </>
  ),
  pullRequest: (
    <>
      <circle cx="4" cy="4" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <path d="M4 5.75v8.25M8.5 4h2.2A1.3 1.3 0 0 1 12 5.3v4.95" />
    </>
  ),
  worklog: (
    <>
      <path d="M3.5 12.5v-9A1.5 1.5 0 0 1 5 2h7.5v10H5a1.5 1.5 0 0 0 0 3h7.5v-3" />
      <path d="M6.5 5.5h3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  selector: <path d="m5 6 3-3 3 3M5 10l3 3 3-3" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-icon={name}
    >
      {PATHS[name]}
    </svg>
  )
}
