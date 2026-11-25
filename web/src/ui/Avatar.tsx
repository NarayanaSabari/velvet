import { Avatar as AstryxAvatar } from '@astryxdesign/core/Avatar'

import type { User } from '../lib/types'
import { userLabel } from '../lib/userLabel'

// Velvet's three sizes, in the pixel sizes Astryx offers.
const SIZES = { sm: 16, md: 24, lg: 32 } as const

export function Avatar({ user, size = 'sm' }: { user: User | null; size?: keyof typeof SIZES }) {
  const label = userLabel(user)
  // No hover card: Astryx's makes each avatar a keyboard stop, and Velvet's
  // lists show dozens of them. The name stays as the accessible name and as
  // a plain hover title.
  return (
    <span title={label} className="inline-flex shrink-0 align-middle">
      <AstryxAvatar name={label} alt={label} src={user?.avatar_url || undefined} size={SIZES[size]} tooltip={false} />
    </span>
  )
}
