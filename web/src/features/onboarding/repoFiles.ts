/**
 * The per-repository half of an agent's instructions. The hosted MCP endpoint
 * cannot see which checkout an agent is in, so the repository names its own
 * Velvet project in a file every major agent already reads. The block holds
 * no secret, so it is safe to commit and shares one setup with the whole team.
 */

export interface RepoProject {
  key: string
  name: string
}

export type RepoFileId = 'agents' | 'claude' | 'cursor'

/** A project key suggestion from a name, following the server's key rules. */
export function projectKeyFrom(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

export interface RepoFile {
  id: RepoFileId
  label: string
  /** Where the block goes, in one short sentence. */
  where: string
  content: string
}

export function repoInstructions({
  workspaceName,
  workspaceSlug,
  issuePrefix,
  project,
}: {
  workspaceName: string
  workspaceSlug: string
  issuePrefix: string
  project: RepoProject
}): string {
  return [
    '## Velvet work log',
    '',
    `This repository logs work to the Velvet project \`${project.key}\` (${project.name}) in the ${workspaceName} organisation (\`${workspaceSlug}\`), through the \`velvet\` MCP server.`,
    '',
    '- After each meaningful unit of work, record a factual 1-3 sentence entry with `velvet_log_work`.',
    `- If the current branch names a ticket such as \`${issuePrefix}-42\`, pass the branch to \`velvet_current_ticket\` and log against that ticket.`,
    `- Otherwise log against the project: \`velvet_log_work\` with \`project: "${project.key}"\`. Never skip logging because no ticket exists.`,
    `- File new tickets for this repository under \`project: "${project.key}"\`.`,
    `- If the \`velvet\` server is connected to an organisation other than \`${workspaceSlug}\`, say so instead of logging there.`,
    '- Never change a ticket status unless asked, and never invent time spent.',
    '',
  ].join('\n')
}

export function repoFiles(input: Parameters<typeof repoInstructions>[0]): RepoFile[] {
  const block = repoInstructions(input)
  return [
    {
      id: 'agents',
      label: 'AGENTS.md',
      where: 'Add this to AGENTS.md in the repository root. Codex, Cursor, and most other agents read it.',
      content: block,
    },
    {
      id: 'claude',
      label: 'CLAUDE.md',
      where: 'Add this to CLAUDE.md in the repository root, which Claude Code reads. If the repository already keeps its rules in AGENTS.md, a CLAUDE.md containing @AGENTS.md is enough.',
      content: block,
    },
    {
      id: 'cursor',
      label: 'Cursor rule',
      where: 'Save this as .cursor/rules/velvet.mdc in the repository. Cursor applies it to every chat in this project.',
      content: ['---', 'description: Log work to Velvet', 'alwaysApply: true', '---', '', block].join('\n'),
    },
  ]
}
