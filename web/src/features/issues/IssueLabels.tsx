import { ErrorNote } from '../../ui/ErrorNote'
import { useState } from 'react'

import type { Label } from '../../lib/types'
import { CheckboxField } from '../../ui/fields'

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
          <CheckboxField
            key={label.id}
            label={label.name}
            checked={selected.includes(label.id)}
            onChange={(checked) => void toggle(label.id, checked)}
          />
        ))}
      </fieldset>
      {failed ? (
        <ErrorNote className="mt-1">Could not update labels. Try again.</ErrorNote>
      ) : null}
    </div>
  )
}
