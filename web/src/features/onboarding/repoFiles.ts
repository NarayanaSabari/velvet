/**
 * The per-repository setup. `velvet init` links a checkout to one project and
 * writes velvet.yaml; this block tells agents to use the CLI there. It names
 * no organisation, project, or key, because velvet.yaml and the server's
 * scoped key already decide those, so the same block suits every repository.
 */

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

/** The one-line installer, served by this Velvet server. */
export function installCommand(baseUrl: string): string {
  const origin = baseUrl.replace(/\/+$/, '')
  return `curl -fsSL ${origin}/install.sh | VELVET_SERVER=${origin} sh`
}

/** Sign in once per machine before selecting a repository in the terminal. */
export function loginCommand(baseUrl: string): string {
  return `velvet login --server ${baseUrl.replace(/\/+$/, '')}`
}

/** What to run in the repository, the first time on each machine. */
export function initCommand(baseUrl: string): string {
  return `velvet init --server ${baseUrl.replace(/\/+$/, '')}`
}

export interface RepoFile {
  id: RepoFileId
  label: string
  /** Where the block goes, in one short sentence. */
  where: string
  content: string
}

export function repoInstructions(): string {
  return [
    '## Velvet work log',
    '',
    'This repository logs work to Velvet with the `velvet` CLI. `velvet.yaml` names the project, and the key `velvet init` stored on this machine can reach only that project.',
    '',
    '- After each meaningful unit of work, log a factual 1-3 sentence entry: `velvet log KEY "what changed and why"` when the branch names a ticket (`velvet key-from-branch` prints it), otherwise `velvet log "..."` for the project. Never skip logging because no ticket exists.',
    '- Put `--kind decision`, `--kind blocker`, or `--kind note` before the message when that fits better than progress, for example `velvet log KEY --kind decision "..."`.',
    '- Attach a pull request or commit with `velvet attach KEY REFERENCE`.',
    '- File new tickets with `velvet new "title"`. Read one with `velvet issue KEY`, and list them with `velvet issues`.',
    '- Attach a user-provided image with `velvet upload-image KEY PATH --caption "why it matters"`. If no image file exists, ask for it instead of claiming an upload.',
    '- If a command says the repository is not linked or the key is missing, ask the person to run `velvet init`. Never edit `velvet.yaml` to reach another project.',
    '- Never change a ticket status unless asked (`velvet status KEY STATUS`), and never invent time spent.',
    '',
  ].join('\n')
}

export function repoFiles(): RepoFile[] {
  const block = repoInstructions()
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
