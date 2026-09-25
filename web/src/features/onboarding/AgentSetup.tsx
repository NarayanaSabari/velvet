import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '../../ui/Button'
import { apiTokensQuery, type ApiToken } from '../profile/apiTokens'
import { agentSnippets, type AgentId } from './agentSnippets'
import { onboardingQuery } from './onboardingQuery'

/**
 * The pieces shared by first-run onboarding and Profile > Agent config: a key
 * made for one agent setup, copyable values, per-agent setup tabs, and a live
 * status that confirms when that key first reaches Velvet.
 */

export function AgentTabs({ baseUrl, slug, token }: { baseUrl: string; slug: string; token: string }) {
  const tabsId = useId()
  const snippets = agentSnippets(baseUrl, slug, token)
  const [agent, setAgent] = useState<AgentId>('claude')
  const current = snippets.find((snippet) => snippet.id === agent) ?? snippets[0]!
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const moveTab = (offset: number) => {
    const index = snippets.findIndex((snippet) => snippet.id === agent)
    const next = snippets[(index + offset + snippets.length) % snippets.length]!
    setAgent(next.id)
    tabRefs.current[next.id]?.focus()
  }

  return (
    <div>
      <div role="tablist" aria-label="Choose your agent" className="flex flex-wrap gap-1 border-b border-grey-200">
        {snippets.map((snippet) => (
          <button
            key={snippet.id}
            ref={(element) => { tabRefs.current[snippet.id] = element }}
            type="button"
            role="tab"
            id={`${tabsId}-${snippet.id}`}
            aria-selected={snippet.id === agent}
            aria-controls={`${tabsId}-panel`}
            tabIndex={snippet.id === agent ? 0 : -1}
            onClick={() => setAgent(snippet.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') { event.preventDefault(); moveTab(1) }
              if (event.key === 'ArrowLeft') { event.preventDefault(); moveTab(-1) }
            }}
            className={`-mb-px min-h-11 border-b-2 px-3 text-sm ${snippet.id === agent ? 'border-ink font-medium text-ink' : 'border-transparent text-grey-700 hover:text-ink'}`}
          >
            {snippet.label}
          </button>
        ))}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${current.id}`} className="space-y-3 pt-4">
        <p className="text-sm text-grey-700">{current.where}</p>
        <CopyField label={`${current.label} setup`} value={current.code} multiline testId="agent-snippet" />
        {current.after ? <p className="text-xs text-grey-500 [overflow-wrap:anywhere]">{current.after}</p> : null}
      </div>
    </div>
  )
}

function usedAt(data: { tokens: ApiToken[] } | undefined, tokenId: string) {
  return data?.tokens.find((token) => token.id === tokenId)?.last_used_at ?? null
}

/**
 * Watches one key until an agent first uses it, so the person sees the setup
 * worked without coming back to check. Watching the key rather than the
 * account means a second agent is not reported as connected by the first.
 */
export function AgentConnection({
  tokenId,
  workspaceName,
  connectedAction,
}: {
  tokenId: string
  workspaceName: string
  connectedAction?: ReactNode
}) {
  const client = useQueryClient()
  const tokens = useQuery({
    ...apiTokensQuery,
    refetchInterval: (query) => (usedAt(query.state.data, tokenId) ? false : 3000),
  })
  const connected = Boolean(usedAt(tokens.data, tokenId))

  useEffect(() => {
    // The dashboard prompt reads the account-wide state, so refresh it once.
    if (connected) void client.invalidateQueries({ queryKey: onboardingQuery.queryKey })
  }, [client, connected])

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        data-testid="agent-connection"
        data-connected={connected ? 'true' : 'false'}
        className={`flex items-start gap-3 rounded-[var(--radius-surface)] border p-4 text-sm ${connected ? 'border-done' : 'border-grey-200'}`}
      >
        <span
          aria-hidden="true"
          className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${connected ? 'bg-done' : 'animate-pulse bg-grey-500 motion-reduce:animate-none'}`}
        />
        {connected ? (
          <div>
            <p className="font-medium">Your agent is connected.</p>
            <p className="mt-1 text-grey-700 [overflow-wrap:anywhere]">
              Ask it to log what it just did, and the entry appears in {workspaceName}.
            </p>
          </div>
        ) : (
          <div>
            <p className="font-medium">Waiting for your agent…</p>
            <p className="mt-1 text-grey-700">
              After pasting the setup, start your agent and ask it: “Which Velvet organisation are you connected to?”
            </p>
          </div>
        )}
      </div>
      {connected ? connectedAction : null}
    </>
  )
}

export function CopyField({ label, value, multiline = false, testId }: { label: string; value: string; multiline?: boolean; testId: string }) {
  const labelId = useId()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span id={labelId} className="text-xs text-grey-500">{label}</span>
        <Button className="min-h-11 shrink-0" aria-label={`Copy ${label}`} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        aria-labelledby={labelId}
        data-testid={testId}
        tabIndex={0}
        className={`mt-1 overflow-x-auto rounded-[var(--radius-control)] border border-grey-200 bg-grey-100 p-3 font-mono text-xs text-ink ${multiline ? 'whitespace-pre-wrap break-all' : 'whitespace-pre-wrap [overflow-wrap:anywhere]'}`}
      >
        {value}
      </pre>
      {failed ? <p role="alert" className="mt-1 text-xs text-blocked">Could not copy. Select the text and copy it manually.</p> : null}
    </div>
  )
}
