import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { clearPrivateQueries, navigateTo } from '../auth/sessionNavigation'

/**
 * Kept last and set apart with the destructive colour, so it is never mistaken
 * for an ordinary setting. Deleting needs the slug typed out in full.
 */
export function DangerPanel({ slug, navigate = navigateTo }: { slug: string; navigate?: (to: string) => void }) {
  const [confirm, setConfirm] = useState('')
  const client = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api.del(`/w/${slug}`, { confirm }),
    onSuccess: async () => { await clearPrivateQueries(client); navigate('/') },
  })
  return (
    <section
      id="danger-zone"
      className="scroll-mt-4 space-y-3 rounded-[var(--radius-surface)] border border-blocked p-4"
      aria-labelledby="delete-heading"
    >
      <div>
        <p className="text-xs font-medium text-blocked">Danger zone</p>
        <h2 id="delete-heading" className="mt-1 text-sm font-medium text-ink">Delete organisation</h2>
        <p className="mt-1 max-w-[46rem] text-sm text-grey-700">
          Permanently delete this organisation, its issues, sprints, invitations and repository connections. This cannot be undone.
        </p>
      </div>
      <form className="max-w-2xl space-y-3" onSubmit={(event) => { event.preventDefault(); if (confirm === slug) remove.mutate() }}>
        <label className="block text-sm">Type <span className="font-mono font-medium">{slug}</span> to confirm deletion
          <input
            className="ui-control mt-1 block min-h-10 w-full px-2 py-1 font-mono"
            autoComplete="off"
            spellCheck={false}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        <Button variant="danger" type="submit" disabled={confirm !== slug || remove.isPending}>
          {remove.isPending ? 'Deleting organisation…' : 'Delete organisation'}
        </Button>
        {remove.error ? <p role="alert" className="text-sm text-blocked">{remove.error.message}</p> : null}
      </form>
    </section>
  )
}
