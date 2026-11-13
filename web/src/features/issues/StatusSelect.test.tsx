import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { StatusSelect } from './StatusSelect'

function openAt(top: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top, bottom: top + 32, left: 0, right: 100, width: 100, height: 32, x: 0, y: top, toJSON: () => ({}),
  } as DOMRect)
  render(<StatusSelect value="todo" onChange={() => {}} />)
  fireEvent.click(screen.getByTestId('status-listbox'))
  return screen.getByTestId('status-listbox-options')
}

describe('StatusSelect placement', () => {
  it('opens downwards when there is room below', () => {
    window.innerHeight = 900
    expect(openAt(100).dataset.placement).toBe('bottom')
    vi.restoreAllMocks()
  })

  it('opens upwards near the viewport bottom', () => {
    window.innerHeight = 900
    expect(openAt(800).dataset.placement).toBe('top')
    vi.restoreAllMocks()
  })
})
