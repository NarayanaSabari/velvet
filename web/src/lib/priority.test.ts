import { expect, it } from 'vitest'

import { priorityOption } from './priority'

it('names priority 0 as none and leaves 1 to 4 unranked', () => {
  expect(priorityOption(0)).toBe('P0 (none)')
  expect(priorityOption(3)).toBe('P3')
})
