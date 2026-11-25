import { Timestamp } from '@astryxdesign/core/Timestamp'

/**
 * A moment, shown as how long ago it was. Hovering it shows the exact date
 * and time.
 */
export function RelativeTime({ iso }: { iso: string }) {
  // Astryx cannot draw a value that is not a date, so that is shown as given.
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return <span className="text-grey-500">{iso}</span>
  // No hover card: Astryx's makes each time a keyboard stop, and a list has
  // one per row. The exact time is a plain hover title instead.
  return (
    <span title={date.toLocaleString()}>
      <Timestamp value={iso} format="relative" type="inherit" color="secondary" hasTooltip={false} />
    </span>
  )
}
