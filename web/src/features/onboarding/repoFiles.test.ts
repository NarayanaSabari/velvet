import { describe, expect, it } from 'vitest'

import { projectKeyFrom, repoFiles, repoInstructions } from './repoFiles'

const input = {
  workspaceName: 'Acme',
  workspaceSlug: 'acme',
  issuePrefix: 'ACM',
  project: { key: 'widgets', name: 'Widgets' },
}

describe('repository instructions', () => {
  it('names the organisation, project, and how to choose where to log', () => {
    const block = repoInstructions(input)
    expect(block.startsWith('## Velvet work log\n')).toBe(true)
    expect(block).toContain('Velvet project `widgets` (Widgets) in the Acme organisation (`acme`)')
    expect(block).toContain('`velvet_current_ticket`')
    expect(block).toContain('`velvet_log_work` with `project: "widgets"`')
    expect(block).toContain('`ACM-42`')
    expect(block).toContain('connected to an organisation other than `acme`')
    expect(block).toContain('never invent time spent')
  })

  it('offers the same block for AGENTS.md and CLAUDE.md, and a Cursor rule with front matter', () => {
    const files = Object.fromEntries(repoFiles(input).map((file) => [file.id, file]))
    const block = repoInstructions(input)
    expect(files.agents!.content).toBe(block)
    expect(files.claude!.content).toBe(block)
    expect(files.cursor!.content).toBe(`---\ndescription: Log work to Velvet\nalwaysApply: true\n---\n\n${block}`)
  })

  it('suggests project keys that follow the server rules', () => {
    expect(projectKeyFrom('Mobile App')).toBe('mobile-app')
    expect(projectKeyFrom('  Café Menu v2!  ')).toBe('cafe-menu-v2')
    expect(projectKeyFrom('a'.repeat(39) + ' b')).toBe('a'.repeat(39))
    expect(projectKeyFrom('தமிழ்')).toBe('')
  })
})
