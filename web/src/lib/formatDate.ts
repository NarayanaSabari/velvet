const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Formats an ISO date or timestamp as "1 Nov 2026" using its own calendar day, never the viewer's timezone. */
export function formatDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!match) return iso
  const [, year, month, day] = match
  const name = MONTHS[Number(month) - 1]
  if (!name || Number(day) < 1 || Number(day) > 31) return iso
  return `${Number(day)} ${name} ${year}`
}

/** Turns an API state value such as "in_progress" into "In progress". */
export function stateLabel(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value
}
