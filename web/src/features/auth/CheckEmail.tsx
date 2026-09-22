import { NavLink } from '../../app/nav'
import { buttonClassName } from '../../ui/buttonStyles'
import { PublicPageLayout } from '../landing/PublicPageLayout'

export function CheckEmail() {
  return (
    <PublicPageLayout signingIn>
      <section aria-labelledby="check-email-title" className="landing-signin">
        <div className="flex items-baseline justify-between gap-2 border-b border-grey-200 py-2">
          <h2 id="check-email-title" className="text-sm font-medium">Check your email</h2>
          <p className="text-xs text-grey-500">No password needed</p>
        </div>
        <div className="landing-signin-form">
          <p className="text-sm text-grey-700">If the request can be sent, you will receive a sign-in link. Open it and click Sign in to continue.</p>
          <p className="mt-4 text-xs text-grey-500">The link expires in 15 minutes. If you don’t see it, check your spam folder.</p>
          <NavLink
            to="/signin"
            className={buttonClassName('primary', 'mt-6 inline-flex min-h-12 w-full items-center justify-center px-4 no-underline')}
          >
            Request another link
          </NavLink>
        </div>
      </section>
    </PublicPageLayout>
  )
}
