import type { QueryClient } from '@tanstack/react-query'

export const navigateTo = (to: string) => window.location.assign(to)

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
