import type { PullRequest } from '../../lib/types'

export function pullRequestStateLabel(
  pr: Pick<PullRequest, 'draft' | 'merged_at' | 'state'>,
): string {
  if (pr.draft) return 'Draft'
  if (pr.state === 'merged' || pr.merged_at) return 'Merged'

  const state = pr.state.replaceAll('_', ' ')
  return state ? state.charAt(0).toUpperCase() + state.slice(1) : 'Unknown'
}
