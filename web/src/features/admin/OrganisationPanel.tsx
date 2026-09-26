import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Membership, Workspace } from '../../lib/types'
import { Button } from '../../ui/Button'
import { SectionHeader } from '../../ui/PageHeader'
import { refreshPrivateQueries } from '../auth/sessionNavigation'

export function OrganisationPanel({ slug, workspace }: { slug: string; workspace: Membership }) {
  const client = useQueryClient()
  const [name, setName] = useState(workspace.workspace_name)
  const [saved, setSaved] = useState(false)
  const update = useMutation({
    mutationFn: () => api.patch<Workspace>(`/w/${slug}`, { name: name.trim() }),
    onSuccess: async (updated) => {
      setName(updated.name)
      setSaved(true)
      await refreshPrivateQueries(client)
    },
  })

  useEffect(() => {
    setName(workspace.workspace_name)
  }, [workspace.workspace_name])

  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 4000)
    return () => window.clearTimeout(timer)
  }, [saved])

  const changed = name.trim() !== workspace.workspace_name
  return (
    <section id="organisation" className="mb-10 scroll-mt-4" aria-labelledby="organisation-heading">
      <SectionHeader id="organisation-heading" title="Organisation" />
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (changed) update.mutate() }}>
        <label className="block max-w-2xl">
          <span className="mb-0.5 block text-xs text-grey-500">Name</span>
          <span className="flex flex-wrap gap-2">
            <input
              className="ui-control min-h-10 min-w-0 flex-1 basis-56 px-2 py-1"
              aria-label="Organisation name"
              value={name}
              maxLength={80}
              onChange={(event) => { update.reset(); setSaved(false); setName(event.target.value) }}
            />
            <Button className="min-h-10" variant="primary" type="submit" disabled={!changed || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </span>
          <span className="mt-1 block text-xs text-grey-500">Shown in the sidebar, invitations, and agent setups.</span>
        </label>
        <div aria-live="polite">
          {saved && !changed ? <p role="status" className="text-sm text-done">Name saved.</p> : null}
        </div>
        {update.error ? <p role="alert" className="text-sm text-blocked">{update.error.message}</p> : null}
        <dl className="overflow-hidden rounded-[var(--radius-surface)] border border-grey-200">
          <div className="grid gap-1 px-3 py-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-sm text-grey-500">Slug</dt>
            <dd>
              <div className="font-mono text-sm">{workspace.workspace_slug}</div>
              <p className="text-xs text-grey-500">Part of every URL, so it cannot change.</p>
            </dd>
          </div>
          <div className="grid gap-1 border-t border-grey-200 px-3 py-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-sm text-grey-500">Issue prefix</dt>
            <dd>
              <div className="font-mono text-sm">{workspace.issue_prefix}</div>
              <p className="text-xs text-grey-500">Stamped into existing ticket keys such as {workspace.issue_prefix}-42, so it cannot change.</p>
            </dd>
          </div>
        </dl>
      </form>
    </section>
  )
}
