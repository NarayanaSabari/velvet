import DOMPurify from 'dompurify'

let sequence = 0
let queue: Promise<unknown> = Promise.resolve()

/** Mermaid has global configuration and a render queue. Keep themes isolated per render. */
export function renderDiagram(source: string, dark: boolean): Promise<string> {
  const result = queue.then(async () => {
    if (source.length > 20_000) throw new Error('Diagram is too large. Keep it under 20,000 characters.')
    // User configuration can inject CSS or change renderer behavior. Comments accept diagrams, not config.
    if (/%%\s*\{|^\s*---/m.test(source)) {
      throw new Error('Diagram configuration is not supported. Remove the configuration block and try again.')
    }
    if (/\bimg\s*:|<\s*(?:img|image)\b|url\s*\(|@import/i.test(source)) {
      throw new Error('External images are not supported in diagrams. Use text labels instead.')
    }
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 20_000,
      maxEdges: 500,
      htmlLabels: false,
      theme: 'base',
      look: 'classic',
      layout: 'dagre',
      themeVariables: {
        darkMode: dark,
        background: dark ? '#0a0a0a' : '#ffffff',
        primaryColor: dark ? '#171717' : '#f5f5f5',
        primaryTextColor: dark ? '#ffffff' : '#000000',
        primaryBorderColor: dark ? '#a3a3a3' : '#737373',
        lineColor: dark ? '#a3a3a3' : '#737373',
        secondaryColor: dark ? '#262626' : '#e5e5e5',
        tertiaryColor: dark ? '#171717' : '#f5f5f5',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        fontSize: '16px',
      },
    })
    const id = `velvet-diagram-${++sequence}`
    try {
      const { svg } = await mermaid.render(id, source)
      return DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'image', 'a', 'use'],
      })
    } finally {
      // Some parsers leave an error diagram behind even when rendering rejects.
      document.getElementById(`d${id}`)?.remove()
    }
  })
  queue = result.catch(() => undefined)
  return result
}

/** No scripts, network, forms or top-level navigation, even if a renderer regression occurs. */
export function diagramDocument(svg: string, dark: boolean, expanded = false) {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:${dark ? '#0a0a0a' : '#ffffff'};color:${dark ? '#fff' : '#000'};height:100%;overflow:hidden}body{display:grid;place-items:center;padding:16px;box-sizing:border-box}svg{${expanded ? 'max-width:100%!important;width:100%;height:100%' : 'max-width:100%;width:100%;height:auto'};max-height:100%}</style></head><body>${svg}</body></html>`
}
