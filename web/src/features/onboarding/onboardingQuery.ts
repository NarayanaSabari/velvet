import { api } from '../../lib/api'

export interface OnboardingPayload {
  state: { has_organisation: boolean; has_token: boolean; agent_connected: boolean }
  suggestion: { name: string; slug: string; issue_prefix: string }
  base_url: string
}

/** One cache entry shared by the setup screen and the dashboard card, so a
 *  connected agent hides the card as soon as either notices. */
export const onboardingQuery = {
  queryKey: ['onboarding'] as const,
  queryFn: () => api.get<OnboardingPayload>('/me/onboarding'),
}
