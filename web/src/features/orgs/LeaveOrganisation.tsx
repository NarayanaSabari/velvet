import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { clearPrivateQueries, navigateTo } from '../auth/sessionNavigation'

export function LeaveOrganisation({ slug, navigate = navigateTo }: { slug: string; navigate?: (to: string) => void }) {
  const [confirm, setConfirm] = useState(false)
  const client = useQueryClient()
  const leave = useMutation({
    mutationFn: () => api.post(`/w/${slug}/leave`),
    onSuccess: async () => { await clearPrivateQueries(client); navigate('/') },
  })
  return <div className="mt-3 text-sm">
    {confirm ? <div className="space-y-2">
      <p>Leave {slug}? You will need an invitation to rejoin.</p>
      <Button variant="danger" disabled={leave.isPending} onClick={() => leave.mutate()}>Confirm leave</Button>{' '}
      <Button disabled={leave.isPending} onClick={() => setConfirm(false)}>Cancel</Button>
    </div> : <button type="button" className="text-grey-500 underline" onClick={() => setConfirm(true)}>Leave organisation</button>}
    {leave.error ? <p role="alert" className="mt-2 text-blocked">{leave.error.message}</p> : null}
  </div>
}
