/**
 * Ready-to-paste configuration for each coding agent, so connecting Velvet is
 * one copy and one paste. Every snippet points at the hosted MCP endpoint for
 * one organisation and authenticates with a personal API token.
 */
export type AgentId = 'claude' | 'codex' | 'cursor' | 'vscode' | 'other'

export interface AgentSnippet {
  id: AgentId
  label: string
  /** Where the snippet goes, in one short sentence. */
  where: string
  code: string
  /** Optional follow-up that makes the setup take effect. */
  after?: string
}

export function mcpUrl(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/w/${encodeURIComponent(slug)}/mcp`
}

export function agentSnippets(baseUrl: string, slug: string, token: string): AgentSnippet[] {
  const url = mcpUrl(baseUrl, slug)
  const header = `Authorization: Bearer ${token}`
  const json = (value: unknown) => JSON.stringify(value, null, 2)

  return [
    {
      id: 'claude',
      label: 'Claude Code',
      where: 'Run this once in a terminal. It connects Velvet in every project.',
      code: `claude mcp add --transport http --scope user velvet ${url} \\\n  --header "${header}"`,
      after: 'Check it with claude mcp list, which should show velvet as connected.',
    },
    {
      id: 'codex',
      label: 'Codex',
      where: 'Codex reads the key from an environment variable. Add both lines to your shell profile, then run the second once.',
      code: `export VELVET_TOKEN=${token}\ncodex mcp add velvet --url ${url} --bearer-token-env-var VELVET_TOKEN`,
      after: 'Open a new terminal so VELVET_TOKEN is set before starting Codex. Codex asks before each Velvet tool call; approve Velvet once in the prompt to let it log freely.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      where: 'Add this to ~/.cursor/mcp.json, merging it with any servers already there.',
      code: json({ mcpServers: { velvet: { url, headers: { Authorization: `Bearer ${token}` } } } }),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      where: 'Add this to .vscode/mcp.json in your project, or to your user MCP configuration.',
      code: json({ servers: { velvet: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }),
    },
    {
      id: 'other',
      label: 'Other',
      where: 'For agents that only run local MCP servers, bridge to Velvet with mcp-remote. Node 18 or later is required.',
      code: json({
        mcpServers: {
          velvet: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', header] },
        },
      }),
      after: `Any agent that supports remote HTTP MCP servers can use ${url} with the header ${header.replace(token, '<your key>')}.`,
    },
  ]
}
