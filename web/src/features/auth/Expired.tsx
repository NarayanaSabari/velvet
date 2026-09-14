import { NavLink } from '../../app/nav'

export function Expired() {
  return <main className="mx-auto mt-24 max-w-sm space-y-4 border border-grey-200 px-6 py-8">
    <h1 className="text-lg">Link expired</h1>
    <p className="text-grey-500">This link is missing, expired, or already used. Request a new sign-in link. For an invitation, ask an admin to resend it.</p>
    <NavLink to="/signin" className="underline">Request a new sign-in link</NavLink>
  </main>
}
