const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
]

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function relativeLabel(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const seconds = (then - now) / 1000
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return RTF.format(Math.round(seconds / size), unit)
    }
  }
  return RTF.format(0, 'second')
}

export function RelativeTime({ iso }: { iso: string }) {
  const date = new Date(iso)
  const exact = Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
  return (
    <time dateTime={iso} title={exact} className="text-grey-500">
      {relativeLabel(iso)}
    </time>
  )
}
