import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'

import { PublicAuthPage } from './PublicAuthPage'

export function Expired() {
  return (
    <PublicAuthPage
      title="This link no longer works"
      lead="It has expired, was already used, or is incomplete. Each link works once."
    >
      <Button variant="primary" size="lg" width="100%" href="/signin" label="Request a new sign-in link" />
      <Text as="p" type="supporting" color="secondary" display="block" className="mt-4">
        Was it an invitation? Ask an admin of that organisation to send it again.
      </Text>
    </PublicAuthPage>
  )
}
