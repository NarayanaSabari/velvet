import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { MilestonePageLayout } from './MilestonePage'

it('keeps the milestone narrative log left of the metadata rail', () => {
  render(
    <MilestonePageLayout
      main={<section data-testid="narrative-log">Milestone narrative log</section>}
      sidebar={<aside data-testid="milestone-details">State Target date Sprint Issues</aside>}
    />,
  )

  const columns = screen.getByTestId('milestone-page-columns')
  expect(columns).toHaveClass('grid')
  expect(screen.getByTestId('milestone-main')).toHaveTextContent('Milestone narrative log')
  expect(screen.getByTestId('milestone-sidebar')).toHaveTextContent('State Target date Sprint Issues')
  expect(columns.firstElementChild).toBe(screen.getByTestId('milestone-main'))
  expect(columns.lastElementChild).toBe(screen.getByTestId('milestone-sidebar'))
})
