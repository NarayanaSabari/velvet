import { describe, expect, it } from 'vitest'

import { initCommand, loginCommand, installCommand, projectKeyFrom, repoFiles, repoInstructions } from './repoFiles'

describe('repository instructions', () => {
  it('tells agents to use the velvet CLI, without naming a project or key', () => {
    const block = repoInstructions()
    expect(block.startsWith('## Velvet work log\n')).toBe(true)
    expect(block).toContain('`velvet log KEY "what changed and why"`')
    expect(block).toContain('`velvet key-from-branch`')
    expect(block).toContain('`velvet log "..."` for the project')
    expect(block).toContain('`velvet log KEY --kind decision "..."`')
    expect(block).toContain('`velvet attach KEY REFERENCE`')
    expect(block).toContain('`velvet upload-image KEY PATH --caption')
    expect(block).toContain('ask the person to run `velvet init`')
    expect(block).toContain('Never edit `velvet.yaml` to reach another project')
    expect(block).toContain('never invent time spent')
    expect(block).not.toMatch(/mcp|velvet_[a-z]/i)
  })

  it('offers the same block for AGENTS.md and CLAUDE.md, and a Cursor rule with front matter', () => {
    const files = Object.fromEntries(repoFiles().map((file) => [file.id, file]))
    const block = repoInstructions()
    expect(files.agents!.content).toBe(block)
    expect(files.claude!.content).toBe(block)
    expect(files.cursor!.content).toBe(`---\ndescription: Log work to Velvet\nalwaysApply: true\n---\n\n${block}`)
  })

  it('builds install and link commands for this server', () => {
    expect(installCommand('https://v.example/')).toBe('curl -fsSL https://v.example/install.sh | VELVET_SERVER=https://v.example sh')
    expect(loginCommand('https://v.example/')).toBe('velvet login --server https://v.example')
    expect(initCommand('https://v.example/')).toBe('velvet init --server https://v.example')
  })

  it('suggests project keys that follow the server rules', () => {
    expect(projectKeyFrom('Mobile App')).toBe('mobile-app')
    expect(projectKeyFrom('  Café Menu v2!  ')).toBe('cafe-menu-v2')
    expect(projectKeyFrom('a'.repeat(39) + ' b')).toBe('a'.repeat(39))
    expect(projectKeyFrom('தமிழ்')).toBe('')
  })
})
