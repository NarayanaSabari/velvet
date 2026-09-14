export function userLabel(user: {
  name?: string
  email?: string
  github_login?: string | null
} | null | undefined): string {
  return user?.name || user?.email || user?.github_login || 'Someone'
}
