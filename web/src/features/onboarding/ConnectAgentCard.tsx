import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Button as AstryxButton } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Heading } from '../../ui/Heading'
import { Text } from '@astryxdesign/core/Text'

import { Button } from '../../ui/Button'
import { onboardingQuery } from './onboardingQuery'

const DISMISS_KEY = 'velvet:agent-card-dismissed'

/**
 * A quiet prompt on the dashboard for people who have not connected a coding
 * agent yet. It disappears for good once any agent reaches Velvet, and can be
 * dismissed on this device. It leads to Profile > Agent config, which stays
 * available after the prompt is gone.
 */
export function ConnectAgentCard({ slug }: { slug: string }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })
  const status = useQuery({ ...onboardingQuery, enabled: !dismissed })

  // Only a confirmed "not connected" shows the card. A prompt must never be
  // able to break the dashboard, so an unexpected or failed response hides it.
  if (dismissed || status.data?.state?.agent_connected !== false) return null

  return (
    <section
      aria-labelledby="connect-agent-heading"
      data-testid="connect-agent-card"
      className="mb-6"
    >
      <Card variant="muted" padding={5}>
      <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <Heading level={4} accessibilityLevel={2} id="connect-agent-heading">Connect your coding agent</Heading>
        <Text as="p" color="secondary" display="block" className="mt-1">
          Let Claude Code, Codex, or Cursor log your work here as you go. It takes about a minute.
        </Text>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <AstryxButton variant="primary" href={`/w/${slug}/settings/profile/agent-config`} label="Connect an agent" />
        <Button
          variant="ghost"
          onClick={() => {
            try {
              window.localStorage.setItem(DISMISS_KEY, '1')
            } catch {
              // Storage unavailable: dismiss for this visit only.
            }
            setDismissed(true)
          }}
        >
          Not now
        </Button>
      </div>
      </div>
      </Card>
    </section>
  )
}
