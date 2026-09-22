import { NavLink } from '../../app/nav'
import { buttonClassName } from '../../ui/buttonStyles'
import { PublicAuthPage } from './PublicAuthPage'

export function Expired() {
  return <PublicAuthPage title="Link expired">
    <div className="space-y-4">
      <p className="text-grey-500">This link is missing, expired, or already used. Request a new sign-in link. For an invitation, ask an admin to resend it.</p>
      <NavLink to="/signin" className={buttonClassName('primary', 'inline-flex min-h-12 w-full items-center justify-center px-4 text-center no-underline')}>Request a new sign-in link</NavLink>
    </div>
  </PublicAuthPage>
}
