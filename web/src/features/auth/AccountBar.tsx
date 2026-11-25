import { Link } from '@astryxdesign/core/Link'
import { Text } from '@astryxdesign/core/Text'

import type { User } from '../../lib/types'
import { userLabel } from '../../lib/userLabel'
import { Avatar } from '../../ui/Avatar'
import { SignOutButton } from './SignOutButton'

/**
 * Who is signed in, across the top of a public task page, with the ways out
 * beside it: back to where they came from, and signing out. One quiet row,
 * so the account never competes with the task below it.
 */
export function AccountBar({ user, back }: {
  user: User | null
  back?: { href: string; label: string }
}) {
  return (
    <div className="landing-account" data-testid="account-bar">
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar user={user} size="md" />
        <Text className="min-w-0 [overflow-wrap:anywhere]">
          <Text color="secondary">Signed in as </Text>{userLabel(user)}
        </Text>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
        {back ? <Link href={back.href} color="secondary" hasUnderline>{back.label}</Link> : null}
        <SignOutButton publicStyle />
      </div>
    </div>
  )
}
