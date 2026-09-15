const ISSUE_KEY_PATTERN = /(?:^|[^a-z0-9])([a-z]{2,6}-\d+)(?=$|[^a-z0-9])/i

export function extractIssueKey(branch: string): string | null {
  const match = ISSUE_KEY_PATTERN.exec(branch)
  return match?.[1]?.toUpperCase() ?? null
}
