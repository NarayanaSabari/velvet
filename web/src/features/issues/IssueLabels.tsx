import { useState } from 'react'

import type { Label } from '../../lib/types'

export function IssueLabels({
  labels,
  selected,
  onChange,
}: {
  labels: Label[]
  selected: string[]
  onChange: (ids: string[]) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function toggle(id: string, checked: boolean) {
    const next = checked ? [...selected, id] : selected.filter((value) => value !== id)
    setBusy(true)
    setFailed(false)
    try {
      await onChange(next)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (labels.length === 0) return <p className="text-sm text-grey-500">No labels defined.</p>
  return (
    <div>
      <fieldset className="flex flex-wrap gap-3" disabled={busy}>
        <legend className="sr-only">Issue labels</legend>
        {labels.map((label) => (
          <label key={label.id} className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={selected.includes(label.id)}
              onChange={(event) => void toggle(label.id, event.target.checked)} />
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} />
            {label.name}
          </label>
        ))}
      </fieldset>
      {failed ? (
        <p className="mt-1 text-xs text-blocked" role="alert">Could not update labels. Try again.</p>
      ) : null}
    </div>
  )
}
