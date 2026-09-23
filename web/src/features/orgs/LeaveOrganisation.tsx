import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { clearPrivateQueries, navigateTo } from '../auth/sessionNavigation'

export function LeaveOrganisation({
  slug,
  navigate = navigateTo,
  menuItem = false,
  confirming,
  onConfirmingChange,
}: {
  slug: string
  navigate?: (to: string) => void
  menuItem?: boolean
  confirming?: boolean
  onConfirmingChange?: (confirming: boolean) => void
}) {
  const [localConfirming, setLocalConfirming] = useState(false)
  const isConfirming = confirming ?? localConfirming
  const containerRef = useRef<HTMLDivElement>(null)
  const moveFocusAfterChange = useRef(false)
  const client = useQueryClient()
  const leave = useMutation({
    mutationFn: () => api.post(`/w/${slug}/leave`),
    onSuccess: async () => { await clearPrivateQueries(client); navigate('/') },
  })

  useEffect(() => {
    if (!menuItem || !moveFocusAfterChange.current) return
    moveFocusAfterChange.current = false
    containerRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [isConfirming, menuItem])

  function setConfirming(next: boolean) {
    moveFocusAfterChange.current = true
    setLocalConfirming(next)
    onConfirmingChange?.(next)
  }

  return <div ref={containerRef} role={menuItem && !isConfirming ? 'none' : undefined} className={menuItem ? 'text-sm' : 'mt-3 text-sm'}>
    {isConfirming ? <div className="space-y-2">
      <p>Leave {slug}? You will need an invitation to rejoin.</p>
      <Button variant="danger" disabled={leave.isPending} onClick={() => leave.mutate()}>Confirm leave</Button>{' '}
      <Button disabled={leave.isPending} onClick={() => setConfirming(false)}>Cancel</Button>
    </div> : <button
      type="button"
      role={menuItem ? 'menuitem' : undefined}
      tabIndex={menuItem ? -1 : undefined}
      className={menuItem ? 'block w-full rounded-[6px] px-2 py-1.5 text-left text-grey-500 hover:bg-grey-100 focus-visible:bg-grey-100' : 'text-grey-500 underline'}
      onClick={() => setConfirming(true)}
    >Leave organisation</button>}
    {leave.error ? <p role="alert" className="mt-2 text-blocked">{leave.error.message}</p> : null}
  </div>
}
