import { NavLink } from '../../app/nav'
import { buttonClassName } from '../../ui/buttonStyles'
import { PublicAuthPage } from './PublicAuthPage'

export function CheckEmail() {
  return (
    <PublicAuthPage title="Check your email">
      <p className="text-sm text-grey-700">If the request can be sent, you will receive a sign-in link. Open it and click Sign in to continue.</p>
      <p className="mt-4 text-xs text-grey-500">The link expires in 15 minutes. If you don’t see it, check your spam folder.</p>
      <NavLink
        to="/signin"
        className={buttonClassName('primary', 'mt-6 inline-flex min-h-12 w-full items-center justify-center px-4 no-underline')}
      >
        Request another link
      </NavLink>
    </PublicAuthPage>
  )
}
