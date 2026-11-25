import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { StatusBadge } from './StatusBadge'
import { Markdown } from './Markdown'
import { RelativeTime } from './RelativeTime'
import { Button } from './Button'
import { PageHeader, SectionHeader } from './PageHeader'

describe('Page hierarchy', () => {
  it('keeps one primary heading and associates section headings with actions', () => {
    render(
      <div>
        <PageHeader title="Issues" description="Search and triage work." actions={<Button>New issue</Button>} />
        <SectionHeader id="open-work" title="Open work" meta="3 issues" action={<a href="#all">View all</a>} />
      </div>,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Issues' })).toBeInTheDocument()
    expect(screen.getByText('Search and triage work.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Open work' })).toHaveAttribute('id', 'open-work')
    expect(screen.getByRole('button', { name: 'New issue' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View all' })).toBeInTheDocument()
  })
})

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

    // Astryx draws the variants; Velvet's names map onto its own.
    const variant = (name: string) => screen.getByRole('button', { name }).getAttribute('data-variant')
    expect(variant('Primary')).toBe('primary')
    expect(variant('Secondary')).toBe('secondary')
    expect(variant('Danger')).toBe('destructive')
    expect(variant('Ghost')).toBe('ghost')
    // The touch-target and press-feedback class is still Velvet's.
    expect(screen.getByRole('button', { name: 'Primary' })).toHaveClass('ui-button')
    expect(screen.getByRole('button', { name: 'Ghost' }).className).not.toContain('opacity')
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

  it('preserves readable document structure and names task-list state', () => {
    const { container } = render(
      <Markdown
        source={
          '## Context\n\n```go\nfunc main() {}\n```\n\n- [ ] Link account\n  - [x] Add callback'
        }
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Context' })).toBeInTheDocument()
    expect(screen.getByText('func main() {}').closest('pre')).not.toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Incomplete task: Link account' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Completed task: Add callback' })).toBeDisabled()
    expect(container.firstElementChild).toHaveClass('markdown')
  })
})

describe('RelativeTime', () => {
  it('shows a relative label and the exact time on hover', () => {
    const iso = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    render(<RelativeTime iso={iso} />)
    const el = screen.getByText(/hours ago/)
    expect(el.tagName).toBe('TIME')
    expect(el.closest('[title]')).toHaveAttribute('title', expect.stringContaining('20'))
  })
})

describe('EmptyState', () => {
  it('uses readable message contrast and offers a compact line', async () => {
    
    const { EmptyState } = await import('./EmptyState')
    const { container, rerender } = render(<EmptyState title="No issues" message="Create one" />)
    expect(screen.getByRole('heading', { name: 'No issues' })).toBeInTheDocument()
    expect(screen.getByText('Create one')).toBeInTheDocument()
    expect(container.querySelector('.astryx-card')).not.toBeNull()
    rerender(<EmptyState compact title="No links" message="Branch to link." />)
    expect(container.querySelector('.astryx-card')).toBeNull()
    expect(container.querySelector('p')).toHaveTextContent('No links Branch to link.')
  })
})
