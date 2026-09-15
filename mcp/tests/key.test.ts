import { describe, expect, it } from 'vitest'

import { extractIssueKey } from '../src/key.js'

describe('extractIssueKey', () => {
  it.each([
    ['sabari/eng-42-fix-auth', 'ENG-42'],
    ['feature/BUG-7', 'BUG-7'],
    ['ENG-123', 'ENG-123'],
    ['work/abcde-999_cleanup', 'ABCDE-999'],
  ])('extracts %s as %s', (branch, expected) => {
    expect(extractIssueKey(branch)).toBe(expected)
  })

  it.each(['main', 'release/2026-09', 'feature/eng-42fix', 'x-1'])('returns null for %s', (branch) => {
    expect(extractIssueKey(branch)).toBeNull()
  })
})
