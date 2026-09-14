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

  if (labels.length === 0) {
    return <p className="text-sm text-grey-500">No labels defined. Create one below.</p>
  }
  return (
    <div>
      <fieldset className="flex flex-wrap gap-1.5" disabled={busy}>
        <legend className="sr-only">Issue labels</legend>
        {labels.map((label) => (
          <label
            key={label.id}
            className="inline-flex cursor-pointer items-center gap-1.5 border border-grey-200 px-1.5 py-1 text-xs hover:bg-grey-100"
          >
            <input type="checkbox" checked={selected.includes(label.id)}
              onChange={(event) => void toggle(label.id, event.target.checked)} />
            <span aria-hidden="true" className="h-2 w-2 rounded-full border border-grey-500 bg-grey-100" />
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
