import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { NavLink } from '../../app/nav'
import { buttonClassName } from '../../ui/buttonStyles'
import { onboardingQuery } from './onboardingQuery'

const DISMISS_KEY = 'velvet:agent-card-dismissed'

/**
 * A quiet prompt on the dashboard for people who have not connected a coding
 * agent yet. It disappears for good once any agent reaches Velvet, and can be
 * dismissed on this device.
 */
export function ConnectAgentCard() {
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
      className="ui-surface mb-6 flex flex-wrap items-center justify-between gap-3 bg-grey-100 p-4"
    >
      <div className="min-w-0">
        <h2 id="connect-agent-heading" className="text-sm font-medium">Connect your coding agent</h2>
        <p className="mt-1 text-sm text-grey-700">
          Let Claude Code, Codex, or Cursor log your work here as you go. It takes about a minute.
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <NavLink to="/onboarding" className={buttonClassName('primary', 'inline-flex min-h-11 items-center px-4 no-underline')}>
          Connect an agent
        </NavLink>
        <button
          type="button"
          className={buttonClassName('ghost', 'min-h-11')}
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
        </button>
      </div>
    </section>
  )
}
