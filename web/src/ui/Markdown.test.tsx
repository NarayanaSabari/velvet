import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import createDOMPurify from 'dompurify'

import { Markdown } from './Markdown'

// GHSA-p98j-92pf-mc4p: an after-hook detaching a live subtree must also
// neutralize descendants that the sanitizer's walk will no longer visit.
describe('DOMPurify detached subtree security regression', () => {
  it.each(['afterSanitizeElements', 'afterSanitizeAttributes'] as const)(
    'removes executable attributes when %s detaches an element',
    (hook) => {
      const purify = createDOMPurify(window)
      const root = document.createElement('div')
      root.innerHTML = '<section id="wrap"><img src="x" onerror="ATTACKER()"></section>'
      document.body.appendChild(root)
      const image = root.querySelector('img')!
      const removeWrapper = (node: Node) => {
        if (node instanceof Element && node.id === 'wrap') node.remove()
      }
      if (hook === 'afterSanitizeElements') {
        purify.addHook('afterSanitizeElements', removeWrapper)
      } else {
        purify.addHook('afterSanitizeAttributes', removeWrapper)
      }

      try {
        purify.sanitize(root, { IN_PLACE: true })
        expect(root.querySelector('#wrap')).toBeNull()
        expect(image.hasAttribute('onerror')).toBe(false)
      } finally {
        purify.removeAllHooks()
        root.remove()
      }
    },
  )
})

describe('Markdown security', () => {
  it('strips script, event handlers and executable links from user content', () => {
    const { container } = render(<Markdown source={[
      '# Safe heading',
      '<script>ATTACKER()</script>',
      '<img src="x" onerror="ATTACKER()">',
      '<svg onload="ATTACKER()"></svg>',
      '[Unsafe link](javascript:ATTACKER())',
      '[Safe link](https://example.com/reference)',
    ].join('\n\n')} />)

    expect(screen.getByRole('heading', { name: 'Safe heading' })).toBeInTheDocument()
    expect(container.querySelector('script, [onerror], [onload], a[href^="javascript:"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'Safe link' })).toHaveAttribute('href', 'https://example.com/reference')
  })

  it('preserves readable task checkboxes after sanitization', () => {
    render(<Markdown source={'- [x] Shipped\n- [ ] Verify'} />)
    expect(screen.getByRole('checkbox', { name: 'Completed task: Shipped' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Incomplete task: Verify' })).not.toBeChecked()
  })
})
