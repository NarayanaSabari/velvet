import { NavLink } from '../../app/nav'

export function CheckEmail() {
  return <main className="mx-auto mt-24 max-w-sm space-y-4 border border-grey-200 px-6 py-8">
    <h1 className="text-lg">Check your email</h1>
    <p className="text-grey-500">If the request can be sent, you will receive a sign-in link. Open it and click Sign in to continue.</p>
    <NavLink to="/signin" className="underline">Request another link</NavLink>
  </main>
}
