import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'

import { PublicAuthPage } from './PublicAuthPage'

export function CheckEmail() {
  return (
    <PublicAuthPage
      title="Check your email"
      lead="If that address can sign in, a link is on its way. Open it and choose Sign in."
    >
      {/* The next step happens in the inbox, so nothing here is the main
          action: asking again is the fallback and looks like one. */}
      <ul className="space-y-2 border-y border-grey-200 py-4">
        <li><Text color="secondary">The link works once and expires in 15 minutes.</Text></li>
        <li><Text color="secondary">Nothing after a minute? Look in your spam folder.</Text></li>
      </ul>
      <div className="mt-6">
        <Button size="lg" width="100%" href="/signin" label="Request another link" />
      </div>
    </PublicAuthPage>
  )
}
