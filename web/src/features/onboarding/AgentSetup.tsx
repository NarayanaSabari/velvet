import { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '../../ui/Button'
import { RelativeTime } from '../../ui/RelativeTime'
import { apiTokensQuery, type ApiToken } from '../profile/apiTokens'
import { onboardingQuery } from './onboardingQuery'

/**
 * The pieces shared by first-run onboarding and Profile > Agent config:
 * copyable values, tabbed instruction files, and the live list of
 * repositories linked to an organisation with `velvet init`.
 */

interface CopyTab {
  id: string
  label: string
  where: string
  code: string
  after?: string
}

/** A tab list of copyable snippets, with arrow-key movement between tabs. */
function CopyTabs({ tabs, label, copyLabel, testId }: {
  tabs: CopyTab[]
  label: string
  copyLabel: (tab: CopyTab) => string
  testId: string
}) {
  const tabsId = useId()
  const [selected, setSelected] = useState(tabs[0]!.id)
  const current = tabs.find((tab) => tab.id === selected) ?? tabs[0]!
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const moveTab = (offset: number) => {
    const index = tabs.findIndex((tab) => tab.id === current.id)
    const next = tabs[(index + offset + tabs.length) % tabs.length]!
    setSelected(next.id)
    tabRefs.current[next.id]?.focus()
  }

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-grey-200">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={(element) => { tabRefs.current[tab.id] = element }}
            type="button"
            role="tab"
            id={`${tabsId}-${tab.id}`}
            aria-selected={tab.id === current.id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={tab.id === current.id ? 0 : -1}
            onClick={() => setSelected(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') { event.preventDefault(); moveTab(1) }
              if (event.key === 'ArrowLeft') { event.preventDefault(); moveTab(-1) }
            }}
            className={`-mb-px min-h-11 border-b-2 px-3 text-sm ${tab.id === current.id ? 'border-ink font-medium text-ink' : 'border-transparent text-grey-700 hover:text-ink'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${current.id}`} className="space-y-3 pt-4">
        <p className="text-sm text-grey-700 [overflow-wrap:anywhere]">{current.where}</p>
        <CopyField label={copyLabel(current)} value={current.code} multiline testId={testId} />
        {current.after ? <p className="text-xs text-grey-500 [overflow-wrap:anywhere]">{current.after}</p> : null}
      </div>
    </div>
  )
}

export function RepoFileTabs({ files }: { files: { id: string; label: string; where: string; content: string }[] }) {
  return (
    <CopyTabs
      tabs={files.map((file) => ({ id: file.id, label: file.label, where: file.where, code: file.content }))}
      label="Choose the instructions file"
      copyLabel={(tab) => `${tab.label} instructions`}
      testId="repo-instructions"
    />
  )
}

/** The keys `velvet init` made for one organisation, newest first. */
function linkedKeys(tokens: ApiToken[] | undefined, slug: string): ApiToken[] {
  return (tokens ?? [])
    .filter((token) => token.workspace_slug === slug && token.project_key)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/**
 * The repositories linked to this organisation, kept live while the person
 * runs `velvet init` in a terminal, so approving there shows up here without
 * a reload. Polling stops once one has been used.
 */
export function LinkedRepositories({ slug, workspaceName }: { slug: string; workspaceName: string }) {
  const client = useQueryClient()
  const tokens = useQuery({
    ...apiTokensQuery,
    refetchInterval: (query) => (linkedKeys(query.state.data?.tokens, slug).some((t) => t.last_used_at) ? false : 3000),
  })
  const linked = linkedKeys(tokens.data?.tokens, slug)
  const connected = linked.some((token) => token.last_used_at)

  useEffect(() => {
    // The dashboard prompt reads the account-wide state, so refresh it once.
    if (connected) void client.invalidateQueries({ queryKey: onboardingQuery.queryKey })
  }, [client, connected])

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="agent-connection"
      data-connected={connected ? 'true' : 'false'}
      className={`flex items-start gap-3 rounded-[var(--radius-surface)] border p-4 text-sm ${connected ? 'border-done' : 'border-grey-200'}`}
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${connected ? 'bg-done' : linked.length ? 'bg-grey-500' : 'animate-pulse bg-grey-500 motion-reduce:animate-none'}`}
      />
      {linked.length === 0 ? (
        <div>
          <p className="font-medium">Waiting for velvet init…</p>
          <p className="mt-1 text-grey-700">Run the link command in a repository and approve it in the browser tab it opens.</p>
        </div>
      ) : (
        <div className="min-w-0">
          <p className="font-medium">{connected ? 'Your agent is connected.' : 'Repository linked.'}</p>
          <p className="mt-1 text-grey-700 [overflow-wrap:anywhere]">
            {connected
              ? `Ask it to log what it just did, and the entry appears in ${workspaceName}.`
              : 'Run velvet whoami there to check it works.'}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-grey-500" aria-label="Linked repositories">
            {linked.map((token) => (
              <li key={token.id} className="[overflow-wrap:anywhere]">
                <span className="font-mono text-grey-700">{token.project_key}</span> · {token.name} ·{' '}
                {token.last_used_at ? <>last used <RelativeTime iso={token.last_used_at} /></> : 'not used yet'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
