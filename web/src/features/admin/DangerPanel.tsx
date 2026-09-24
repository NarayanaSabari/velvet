import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { clearPrivateQueries, navigateTo } from '../auth/sessionNavigation'

export function DangerPanel({ slug, navigate = navigateTo }: { slug: string; navigate?: (to: string) => void }) {
  const [confirm, setConfirm] = useState('')
  const client = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api.del(`/w/${slug}`, { confirm }),
    onSuccess: async () => { await clearPrivateQueries(client); navigate('/') },
  })
  return <section className="mt-8 space-y-3" aria-labelledby="delete-heading">
    <h2 id="delete-heading" className="border-b border-grey-200 pb-1 text-base">Delete organisation</h2>
    <p className="text-grey-500">Permanently delete this organisation, its issues, sprints, invitations and repository connections. This cannot be undone.</p>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (confirm === slug) remove.mutate() }}>
      <label className="block">Type {slug} to confirm deletion
        <input className="ui-control mt-1 block min-h-10 w-full px-2 py-1" autoComplete="off" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </label>
      <Button variant="danger" type="submit" disabled={confirm !== slug || remove.isPending}>
        {remove.isPending ? 'Deleting organisation…' : 'Delete organisation'}
      </Button>
      {remove.error ? <p role="alert" className="text-blocked">{remove.error.message}</p> : null}
    </form>
  </section>
}
