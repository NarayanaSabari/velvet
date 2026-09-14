import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { StatusBadge } from './StatusBadge'
import { Markdown } from './Markdown'
import { RelativeTime } from './RelativeTime'
import { List } from './List'
import { Button } from './Button'

describe('Button', () => {
  it('exposes the four monochrome variants and press feedback contract', () => {
    render(
      <div>
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="ghost">Ghost</Button>
      </div>,
    )

    expect(screen.getByRole('button', { name: 'Primary' })).toHaveClass(
      'bg-ink',
      'text-paper',
      'rounded-[6px]',
      'ui-button',
    )
    expect(screen.getByRole('button', { name: 'Secondary' })).toHaveClass(
      'border-grey-300',
    )
    expect(screen.getByRole('button', { name: 'Danger' })).toHaveClass(
      'border-blocked',
      'text-blocked',
    )
    expect(screen.getByRole('button', { name: 'Ghost' })).toHaveClass(
      'border-transparent',
      'bg-transparent',
    )
  })
})

describe('StatusBadge', () => {
  it('names the status in text, never colour alone', () => {
    render(<StatusBadge status="in_progress" />)
    expect(screen.getByText('In progress')).toBeInTheDocument()
  })
})

describe('Markdown', () => {
  it('renders formatting', () => {
    render(<Markdown source="**bold** and `code`" />)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
  })

  it('strips a script tag rather than trusting comment bodies', () => {
    const { container } = render(
      <Markdown source={'before <script>window.pwned = 1</script> after'} />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('before')
  })

  it('strips a javascript: href', () => {
    const { container } = render(
      <Markdown source={'[click](javascript:alert(1))'} />,
    )
    const link = container.querySelector('a')
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:')
  })
})

describe('RelativeTime', () => {
  it('shows a relative label and the exact time on hover', () => {
    const iso = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    render(<RelativeTime iso={iso} />)
    const el = screen.getByText(/hours ago/)
    expect(el).toHaveAttribute('title', expect.stringContaining('20'))
  })
})

describe('List', () => {
  const items = [
    { id: 'a', label: 'First' },
    { id: 'b', label: 'Second' },
    { id: 'c', label: 'Third' },
  ]

  it('moves with j and k and activates with Enter', async () => {
    const onActivate = vi.fn()
    const user = userEvent.setup()

    render(
      <List
        items={items}
        keyExtractor={(i) => i.id}
        renderItem={(i) => <span>{i.label}</span>}
        onActivate={onActivate}
      />,
    )

    await user.tab()
    await user.keyboard('j')
    await user.keyboard('{Enter}')
    expect(onActivate).toHaveBeenCalledWith(items[1])
  })

  it('does not move past the ends', async () => {
    const onActivate = vi.fn()
    const user = userEvent.setup()

    render(
      <List
        items={items}
        keyExtractor={(i) => i.id}
        renderItem={(i) => <span>{i.label}</span>}
        onActivate={onActivate}
      />,
    )

    await user.tab()
    await user.keyboard('kkk')
    await user.keyboard('{Enter}')
    expect(onActivate).toHaveBeenCalledWith(items[0])
  })
})
