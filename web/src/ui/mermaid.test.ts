import { describe, expect, it, vi } from 'vitest'
import { diagramDocument, renderDiagram } from './mermaid'

const renderer = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: renderer }))

describe('diagram renderer safety', () => {
  it('sanitizes SVG and disables HTML labels and click handlers', async () => {
    renderer.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><script>evil()</script><foreignObject><img src="x" /></foreignObject><a href="javascript:evil()"><text>Safe label</text></a><rect width="20"/></svg>' })
    const svg = await renderDiagram('flowchart TD\nA-->B', false)
    expect(svg).not.toMatch(/script|onload|foreignObject|javascript:/)
    expect(svg).toContain('<rect')
    expect(renderer.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ securityLevel: 'strict', htmlLabels: false, startOnLoad: false }))
    const doc = diagramDocument(svg, false)
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("form-action 'none'")
  })

  it.each([
    ['x'.repeat(20_001), 'too large'],
    ['%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B', 'configuration'],
    ['---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\nA-->B', 'configuration'],
    ['flowchart LR\nA@{img: "https://example.com/a.png"}', 'External images'],
    ['flowchart LR\nclassDef a fill:url(/tracking)', 'External images'],
  ])('rejects unsafe or unbounded input before invoking Mermaid', async (source, message) => {
    const before = renderer.render.mock.calls.length
    await expect(renderDiagram(source, false)).rejects.toThrow(message)
    expect(renderer.render).toHaveBeenCalledTimes(before)
  })

  it('recovers the queue after a parser failure and applies the next theme', async () => {
    renderer.render.mockRejectedValueOnce(new Error('bad syntax'))
    await expect(renderDiagram('invalid', false)).rejects.toThrow('bad syntax')
    renderer.render.mockResolvedValueOnce({ svg: '<svg></svg>' })
    await expect(renderDiagram('flowchart TD\nA-->B', true)).resolves.toContain('<svg')
    expect(renderer.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ themeVariables: expect.objectContaining({ darkMode: true }) }))
  })
})
