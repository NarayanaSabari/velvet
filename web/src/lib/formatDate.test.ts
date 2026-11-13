import { describe, expect, it } from 'vitest'
import { formatDay, stateLabel } from './formatDate'

describe('formatDay', () => {
  it('formats dates without timezone shift', () => {
    expect(formatDay('2026-11-01')).toBe('1 Nov 2026')
    expect(formatDay('2026-01-31T23:30:00-08:00')).toBe('31 Jan 2026')
  })
  it('returns unparseable input unchanged', () => {
    expect(formatDay('soon')).toBe('soon')
    expect(formatDay('2026-13-01')).toBe('2026-13-01')
  })
})

describe('stateLabel', () => {
  it('capitalises API values', () => {
    expect(stateLabel('active')).toBe('Active')
    expect(stateLabel('in_progress')).toBe('In progress')
    expect(stateLabel('')).toBe('')
  })
})
