import { SignOutButton } from './SignOutButton'

export function NotInvited() {
  return (
    <div className="mx-auto mt-24 max-w-sm border border-grey-200 px-6 py-8">
      <h1 className="text-lg">Not invited</h1>
      <p className="mt-2 text-sm text-grey-500">
        This GitHub account is not a member of any workspace here. Ask an admin
        to invite your login, then sign in again.
      </p>
      <SignOutButton />
    </div>
  )
}
