import type { User } from '../lib/types'
import { userLabel } from '../lib/userLabel'

const SIZES = { sm: 'h-4 w-4 text-xs', md: 'h-6 w-6 text-xs' } as const

export function Avatar({ user, size = 'sm' }: { user: User | null; size?: 'sm' | 'md' }) {
  const label = userLabel(user)
  const cls = `${SIZES[size]} inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-grey-300 bg-grey-100 align-middle object-cover`

  if (user?.avatar_url) {
    return <img className={cls} src={user.avatar_url} alt={label} title={label} />
  }
  return (
    <span className={cls} title={label} aria-label={label}>
      {label.slice(0, 1).toUpperCase()}
    </span>
  )
}
