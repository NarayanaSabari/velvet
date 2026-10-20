import { StrictMode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Markdown } from './Markdown'
import { renderDiagram } from './mermaid'

vi.mock('./mermaid', () => ({
  renderDiagram: vi.fn(),
  diagramDocument: (svg: string) => svg,
}))

beforeEach(() => {
  vi.mocked(renderDiagram).mockReset()
  vi.mocked(renderDiagram).mockResolvedValue('<svg role="img"></svg>')
})

describe('Mermaid Markdown', () => {
  it('renders fenced diagrams in document order and leaves other code alone', async () => {
    render(<Markdown source={'Before\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n```js\nconst x = 1\n```\n\n```mermaid\nsequenceDiagram\nA->>B: Hello\n```'} />)
    await waitFor(() => expect(screen.getAllByTitle('Rendered Mermaid diagram')).toHaveLength(2))
    expect(renderDiagram).toHaveBeenCalledWith('flowchart LR\nA-->B\n', false)
    expect(renderDiagram).toHaveBeenCalledWith('sequenceDiagram\nA->>B: Hello\n', false)
    expect(screen.getByText('const x = 1')).toBeInTheDocument()
    for (const frame of screen.getAllByTitle('Rendered Mermaid diagram')) {
      expect(frame).toHaveAttribute('sandbox', '')
    }
  })

  it('does not accept forged diagram placeholders from raw HTML', () => {
    render(<Markdown source={'<div data-mermaid-index="0">Not a diagram</div>'} />)
    expect(renderDiagram).not.toHaveBeenCalled()
    expect(screen.getByText('Not a diagram')).toBeInTheDocument()
  })

  it('shows an explicit failure and keeps the source readable', async () => {
    vi.mocked(renderDiagram).mockRejectedValue(new Error('bad syntax'))
    render(<Markdown source={'```mermaid\nbroken diagram\n```'} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not render')
    await userEvent.click(screen.getByRole('button', { name: 'View source' }))
    expect(screen.getByText('broken diagram')).toBeVisible()
  })

  it('shows loading, retries a failure, and keeps portals stable in Strict Mode', async () => {
    let resolve!: (svg: string) => void
    vi.mocked(renderDiagram).mockImplementation(() => new Promise(done => { resolve = done }))
    render(<StrictMode><Markdown source={'```mermaid\nflowchart LR\nA-->B\n```'} /></StrictMode>)
    expect(screen.getByRole('status')).toHaveTextContent('Rendering diagram')
    resolve('<svg></svg>')
    await screen.findByTitle('Rendered Mermaid diagram')
  })

  it('can retry a transient rendering failure', async () => {
    vi.mocked(renderDiagram).mockRejectedValueOnce(new Error('chunk load failed'))
    render(<Markdown source={'```mermaid\nflowchart LR\nA-->B\n```'} />)
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByTitle('Rendered Mermaid diagram')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('mounts a fresh host when Markdown is updated or diagrams are removed', async () => {
    const { rerender } = render(<Markdown source={'```mermaid\nflowchart LR\nA-->B\n```'} />)
    await screen.findByTitle('Rendered Mermaid diagram')
    rerender(<Markdown source={'```mermaid\nflowchart LR\nC-->D\n```'} />)
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledWith('flowchart LR\nC-->D\n', false))
    rerender(<Markdown source="No diagram now" />)
    expect(screen.queryByTitle('Rendered Mermaid diagram')).not.toBeInTheDocument()
    expect(screen.getByText('No diagram now')).toBeInTheDocument()
  })
})
