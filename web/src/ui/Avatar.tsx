import type { User } from '../lib/types'

const SIZES = { sm: 'h-4 w-4 text-[9px]', md: 'h-6 w-6 text-xs' } as const

export function Avatar({ user, size = 'sm' }: { user: User | null; size?: 'sm' | 'md' }) {
  const label = user?.name || user?.github_login || 'Someone'
  const cls = `${SIZES[size]} inline-flex shrink-0 items-center justify-center border border-grey-300 bg-grey-100 align-middle`

  if (user?.avatar_url) {
    return <img className={cls} src={user.avatar_url} alt={label} title={label} />
  }
  return (
    <span className={cls} title={label} aria-label={label}>
      {label.slice(0, 1).toUpperCase()}
    </span>
  )
}
