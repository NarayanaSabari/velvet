import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../lib/api'
import type { Membership, Workspace } from '../../lib/types'
import { Button } from '../../ui/Button'
import { refreshPrivateQueries } from '../auth/sessionNavigation'

export function OrganisationPanel({ slug, workspace }: { slug: string; workspace: Membership }) {
  const client = useQueryClient()
  const [name, setName] = useState(workspace.workspace_name)
  const update = useMutation({
    mutationFn: () => api.patch<Workspace>(`/w/${slug}`, { name: name.trim() }),
    onSuccess: async (updated) => {
      setName(updated.name)
      await refreshPrivateQueries(client)
    },
  })

  useEffect(() => {
    setName(workspace.workspace_name)
  }, [workspace.workspace_name])

  const changed = name.trim() !== workspace.workspace_name
  return (
    <section className="mb-8" aria-labelledby="organisation-heading">
      <h2 id="organisation-heading" className="mb-3 border-b border-grey-200 pb-1 text-base">Organisation</h2>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (changed) update.mutate() }}>
        <label className="block">
          <span className="mb-0.5 block text-xs text-grey-500">Name</span>
          <span className="flex flex-wrap gap-2">
            <input
              className="ui-control min-h-10 min-w-0 flex-1 px-2 py-1"
              aria-label="Organisation name"
              value={name}
              onChange={(event) => { update.reset(); setName(event.target.value) }}
            />
            <Button className="self-end" variant="primary" type="submit" disabled={!changed || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </span>
        </label>
        {update.error ? <p role="alert" className="text-blocked">{update.error.message}</p> : null}
        <dl className="border-t border-grey-200">
          <div className="grid gap-1 border-b border-grey-200 px-2 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-grey-500">Slug</dt>
            <dd>
              <div>{workspace.workspace_slug}</div>
              <p className="text-sm text-grey-500">The slug is part of every URL and cannot change.</p>
            </dd>
          </div>
          <div className="grid gap-1 border-b border-grey-200 px-2 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="text-grey-500">Issue prefix</dt>
            <dd>
              <div>{workspace.issue_prefix}</div>
              <p className="text-sm text-grey-500">The prefix is stamped into existing issue keys and cannot change.</p>
            </dd>
          </div>
        </dl>
      </form>
    </section>
  )
}
