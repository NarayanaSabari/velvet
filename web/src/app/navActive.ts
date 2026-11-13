function normalisePath(path: string) {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? '/'
  if (withoutQuery.length <= 1) return '/'
  return withoutQuery.replace(/\/+$/, '')
}

function currentLocation() {
  if (typeof window === 'undefined') return { pathname: '/', search: '' }
  return { pathname: window.location.pathname, search: window.location.search }
}

export function isNavLinkActive(to: string, location = currentLocation()) {
  if (to.startsWith('#') || /^https?:\/\//.test(to)) return false

  const target = normalisePath(to)
  const current = normalisePath(location.pathname)

  // A link with a query names one filtered view, so it is current only on
  // exactly that path and query, never on pages below the path.
  const queryIndex = to.indexOf('?')
  if (queryIndex !== -1) {
    const query = to.slice(queryIndex).split('#', 1)[0]
    return current === target && location.search === query
  }

  // The workspace root should not remain selected while a deeper page is open.
  if (/^\/w\/[^/]+$/.test(target)) return current === target
  return current === target || current.startsWith(`${target}/`)
}
