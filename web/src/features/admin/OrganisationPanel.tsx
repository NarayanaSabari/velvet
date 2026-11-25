import { ErrorNote } from '../../ui/ErrorNote'
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { Text } from '@astryxdesign/core/Text'

import { api } from '../../lib/api'
import type { Membership, Workspace } from '../../lib/types'
import { Button } from '../../ui/Button'
import { refreshPrivateQueries } from '../auth/sessionNavigation'
import { TextField } from '../../ui/fields'

export function OrganisationPanel({ slug, workspace }: { slug: string; workspace: Membership }) {
  const client = useQueryClient()
  // An unsaved edit wins; otherwise the field follows the server's name.
  const [draft, setName] = useState<string>()
  const name = draft ?? workspace.workspace_name
  const [saved, setSaved] = useState(false)
  const update = useMutation({
    mutationFn: () => api.patch<Workspace>(`/w/${slug}`, { name: name.trim() }),
    onSuccess: async (updated) => {
      setName(updated.name)
      setSaved(true)
      await refreshPrivateQueries(client)
      setName(undefined)
    },
  })

  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 4000)
    return () => window.clearTimeout(timer)
  }, [saved])

  const changed = name.trim() !== workspace.workspace_name
  return (
    <section aria-label="Organisation">
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (changed) update.mutate() }}>
        <div className="flex max-w-2xl flex-wrap items-end gap-2">
          <TextField
            className="flex-1 basis-56"
            label="Name"
            aria-label="Organisation name"
            description="Shown in the sidebar, invitations, and agent setups."
            value={name}
            maxLength={80}
            onChange={(value) => { update.reset(); setSaved(false); setName(value) }}
          />
          <Button variant="primary" type="submit" disabled={!changed || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <div aria-live="polite">
          {saved && !changed ? <p role="status" className="text-sm text-done">Name saved.</p> : null}
        </div>
        {update.error ? <ErrorNote>{update.error.message}</ErrorNote> : null}
        <div className="max-w-2xl border-t border-grey-200 pt-4">
          <MetadataList label={{ position: 'start', width: '8rem' }}>
            <MetadataListItem label="Slug">
              <Text type="code" display="block">{workspace.workspace_slug}</Text>
              <Text type="supporting" color="secondary" display="block">Part of every URL, so it cannot change.</Text>
            </MetadataListItem>
            <MetadataListItem label="Issue prefix">
              <Text type="code" display="block">{workspace.issue_prefix}</Text>
              <Text type="supporting" color="secondary" display="block">Stamped into existing ticket keys such as {workspace.issue_prefix}-42, so it cannot change.</Text>
            </MetadataListItem>
          </MetadataList>
        </div>
      </form>
    </section>
  )
}
