import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { Membership } from '../../lib/types'
import { Button } from '../../ui/Button'
import { SectionHeader } from '../../ui/PageHeader'
import { RelativeTime } from '../../ui/RelativeTime'
import { AgentConnection, AgentTabs, CopyField } from '../onboarding/AgentSetup'
import { mcpUrl } from '../onboarding/agentSnippets'
import { onboardingQuery } from '../onboarding/onboardingQuery'
import { apiTokensQuery, createAgentToken, type ApiToken, type CreatedApiToken } from './apiTokens'

/** The anchor the dashboard prompt and command palette link to. */
const AGENT_CONFIG_ANCHOR = 'agent-config'

function lastUsed(tokens: ApiToken[] | undefined): ApiToken | null {
  let latest: ApiToken | null = null
  for (const token of tokens ?? []) {
    if (token.last_used_at && (!latest?.last_used_at || token.last_used_at > latest.last_used_at)) latest = token
  }
  return latest
}

/**
 * The permanent home for connecting a coding agent, for anyone who skipped
 * it during onboarding or wants to add another agent later. Setting up
 * creates a fresh key, because an existing key is never shown again.
 */
export function AgentConfig({ workspace }: { workspace: Membership }) {
  const client = useQueryClient()
  const setup = useQuery(onboardingQuery)
  const tokens = useQuery(apiTokensQuery)
  const [token, setToken] = useState<CreatedApiToken | null>(null)
  const create = useMutation({
    mutationFn: createAgentToken,
    onSuccess: async (created) => {
      setToken(created)
      await client.invalidateQueries({ queryKey: apiTokensQuery.queryKey })
    },
  })
  const newKeyHeading = useRef<HTMLHeadingElement>(null)

  // Move focus to the new key so keyboard and screen reader users land on it.
  useEffect(() => {
    if (token) newKeyHeading.current?.focus()
  }, [token])

  // A same-page link or a fresh load with #agent-config may arrive before this
  // section exists, so bring it into view once it has rendered.
  useEffect(() => {
    if (window.location.hash === `#${AGENT_CONFIG_ANCHOR}`) {
      document.getElementById(AGENT_CONFIG_ANCHOR)?.scrollIntoView()
    }
  }, [])

  const baseUrl = setup.data?.base_url ?? window.location.origin
  const recent = lastUsed(tokens.data?.tokens)

  return (
    <section id={AGENT_CONFIG_ANCHOR} className="mt-8 scroll-mt-4 space-y-3" aria-labelledby="agent-config-heading">
      <SectionHeader id="agent-config-heading" title="Agent config" />
      <p className="max-w-[46rem] text-grey-500 [overflow-wrap:anywhere]">
        Connect Claude Code, Codex, Cursor, or another coding agent so it logs your work in {workspace.workspace_name} as you go.
      </p>

      <p className="flex items-start gap-2 text-sm" data-testid="agent-config-status">
        <span
          aria-hidden="true"
          className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${recent ? 'bg-done' : 'bg-grey-300'}`}
        />
        {tokens.isPending ? (
          <span className="text-grey-500">Checking for connected agents…</span>
        ) : recent?.last_used_at ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="font-medium">Connected.</span>{' '}
            <span className="text-grey-700">{recent.name} was last used <RelativeTime iso={recent.last_used_at} />.</span>
          </span>
        ) : (
          <span>
            <span className="font-medium">No agent connected yet.</span>{' '}
            <span className="text-grey-700">Setting one up takes about a minute.</span>
          </span>
        )}
      </p>

      {workspace.role === 'viewer' ? (
        <p className="max-w-[46rem] text-sm text-grey-700 [overflow-wrap:anywhere]">
          You are a viewer in {workspace.workspace_name}, so an agent can read its tickets but cannot log work or change them.
        </p>
      ) : null}

      <div className="max-w-3xl space-y-5 pt-2">
        <CopyField label="MCP server URL" value={mcpUrl(baseUrl, workspace.workspace_slug)} testId="agent-mcp-url" />

        {!token ? (
          <div className="space-y-2">
            <Button className="min-h-11 px-4" variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Creating key…' : recent ? 'Set up another agent' : 'Set up an agent'}
            </Button>
            <p className="text-sm text-grey-500">
              This creates a new API key for the agent. Each agent gets its own key, so you can revoke one without affecting the others.
            </p>
            {create.error ? <p role="alert" className="text-sm text-blocked">{create.error.message}</p> : null}
          </div>
        ) : (
          <div className="space-y-5 border-t border-grey-200 pt-4" data-testid="agent-config-setup">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 ref={newKeyHeading} tabIndex={-1} className="font-medium">New key for your agent</h3>
                <p className="mt-1 text-sm text-grey-700">
                  Copy it now. It will not be shown again, and it is listed under API tokens as {token.name}.
                </p>
              </div>
              <Button className="min-h-11" onClick={() => setToken(null)}>Done</Button>
            </div>
            <CopyField label="Your API key" value={token.token} testId="agent-token" />
            <AgentTabs baseUrl={baseUrl} slug={workspace.workspace_slug} token={token.token} />
            <AgentConnection tokenId={token.id} workspaceName={workspace.workspace_name} />
          </div>
        )}
      </div>
    </section>
  )
}
