import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { IssuePageLayout } from '../features/issues/IssuePage'
import { MilestonePageLayout } from '../features/milestones/MilestonePage'

describe('detail page landmarks', () => {
  it.each([
    ['issue', IssuePageLayout],
    ['milestone', MilestonePageLayout],
  ])('keeps the shell as the only main landmark on the %s page', (_name, Layout) => {
    const { container } = render(
      <main>
        <Layout main={<div>narrative</div>} sidebar={<div>metadata</div>} />
      </main>,
    )

    expect(container.querySelectorAll('main')).toHaveLength(1)
  })
})
