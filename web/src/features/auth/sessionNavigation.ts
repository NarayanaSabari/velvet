import type { QueryClient } from '@tanstack/react-query'

export const navigateTo = (to: string) => window.location.assign(to)

/** Only a device code may survive email sign-in as a consent destination. */
export function cliReturnTo(value?: string): string | undefined {
  if (!value) return undefined
  const match = /^\/cli\/approve\?code=([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4})$/i.exec(value)
  return match ? `/cli/approve?code=${match[1]!.toUpperCase()}` : undefined
}

/** Reject browser URL parsing tricks, including backslashes and control characters. */
export function safeSignInNext(value: string): string {
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point.
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/.test(value)) return '/'
  const url = new URL(value, window.location.origin)
  return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : '/'
}

/** Stop old requests before discarding data belonging to a previous identity or membership. */
export async function clearPrivateQueries(client: QueryClient) {
  await client.cancelQueries()
  await client.invalidateQueries({ refetchType: 'none' })
  client.clear()
}

/** Identity appears in members, authors, feeds and reports, including inactive pages. */
export async function refreshPrivateQueries(client: QueryClient) {
  await client.cancelQueries()
  client.removeQueries({ type: 'inactive' })
  await client.invalidateQueries()
}

export function fragmentToken() {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''
}

export function clearFragment() {
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
}
