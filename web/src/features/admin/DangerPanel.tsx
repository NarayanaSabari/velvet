import { ErrorNote } from '../../ui/ErrorNote'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Heading } from '../../ui/Heading'
import { Text } from '@astryxdesign/core/Text'

import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { clearPrivateQueries, navigateTo } from '../auth/sessionNavigation'
import { TextField } from '../../ui/fields'

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
      className="space-y-3 rounded-[var(--radius-surface)] border border-blocked p-4"
      aria-labelledby="delete-heading"
    >
      <div>
        <Heading level={4} accessibilityLevel={2} id="delete-heading">Delete organisation</Heading>
        <Text as="p" color="secondary" display="block" className="mt-1 max-w-[46rem]">
          Permanently delete this organisation, its issues, sprints, invitations and repository connections. This cannot be undone.
        </Text>
      </div>
      <form className="max-w-2xl space-y-3" onSubmit={(event) => { event.preventDefault(); if (confirm === slug) remove.mutate() }}>
        <TextField
          label={`Type ${slug} to confirm deletion`}
          mono
          literal
          autoComplete="off"
          value={confirm}
          onChange={setConfirm}
        />
        <Button variant="danger" type="submit" disabled={confirm !== slug || remove.isPending}>
          {remove.isPending ? 'Deleting organisation…' : 'Delete organisation'}
        </Button>
        {remove.error ? <ErrorNote>{remove.error.message}</ErrorNote> : null}
      </form>
    </section>
  )
}
