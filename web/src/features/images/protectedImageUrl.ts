// Only exact protected endpoints for this record may receive cookie credentials.
// Reject absolute, protocol-relative, encoded traversal and cross-workspace URLs.
export function protectedImageUrl(value: string, slug: string, id: string, kind: 'content' | 'download'): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug) || !/^[a-zA-Z0-9_-]+$/.test(id)) return null
  const expected = `/api/v1/w/${encodeURIComponent(slug)}/images/${encodeURIComponent(id)}/content${kind === 'download' ? '?download=1' : ''}`
  return value === expected ? value : null
}
