import { ErrorNote } from '../../ui/ErrorNote'
import { useEffect, useId, useState } from 'react'
import { Card } from '@astryxdesign/core/Card'
import { List, ListItem } from '@astryxdesign/core/List'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Tab, TabList } from '@astryxdesign/core/TabList'
import { Text } from '@astryxdesign/core/Text'
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

  return (
    <div>
      <TabList role="tablist" value={current.id} onChange={setSelected} hasDivider aria-label={label}>
        {tabs.map((tab) => (
          <Tab key={tab.id} value={tab.id} label={tab.label} panelId={`${tabsId}-panel`} />
        ))}
      </TabList>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-label={current.label} className="space-y-3 pt-4">
        <Text as="p" color="secondary" display="block" className="[overflow-wrap:anywhere]">{current.where}</Text>
        <CopyField label={copyLabel(current)} value={current.code} multiline testId={testId} />
        {current.after ? <Text as="p" type="supporting" color="secondary" display="block" className="[overflow-wrap:anywhere]">{current.after}</Text> : null}
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
 * runs `velvet init` in a terminal, so linking there shows up here without
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
    >
      <Card padding={5}>
        <div className="flex items-start gap-3">
          {/* The dot repeats what the words beside it say; it pulses only while waiting. */}
          <span className="mt-1.5 shrink-0" aria-hidden="true">
            <StatusDot
              variant={connected ? 'success' : 'neutral'}
              label={connected ? 'Connected' : linked.length ? 'Linked' : 'Waiting'}
              isPulsing={linked.length === 0}
            />
          </span>
          {linked.length === 0 ? (
            <div>
              <Text as="p" weight="semibold" display="block">Waiting for velvet init…</Text>
              <Text as="p" color="secondary" display="block" className="mt-1">Approve velvet login in your browser, then run velvet init in the repository and choose its organisation and project in the terminal.</Text>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <Text as="p" weight="semibold" display="block">{connected ? 'Your agent is connected.' : 'Repository linked.'}</Text>
              <Text as="p" color="secondary" display="block" className="mt-1 [overflow-wrap:anywhere]">
                {connected
                  ? `Ask it to log what it just did, and the entry appears in ${workspaceName}.`
                  : 'Run velvet whoami there to check it works.'}
              </Text>
              <div className="mt-3 border-t border-grey-200">
                <List hasDividers density="compact" edge="flush" aria-label="Linked repositories">
                  {linked.map((token) => (
                    <ListItem
                      key={token.id}
                      itemKey={token.id}
                      label={(
                        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere]">
                          <Text type="code">{token.project_key}</Text>
                          <Text>{token.name}</Text>
                        </span>
                      )}
                      endContent={(
                        <Text type="supporting" color="secondary">
                          {token.last_used_at ? <>last used <RelativeTime iso={token.last_used_at} /></> : 'not used yet'}
                        </Text>
                      )}
                    />
                  ))}
                </List>
              </div>
            </div>
          )}
        </div>
      </Card>
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
        <Text type="supporting" color="secondary" id={labelId}>{label}</Text>
        <Button className="shrink-0" aria-label={`Copy ${label}`} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {/* A plain block on purpose. Astryx's CodeBlock draws each line as its
          own element, so its text no longer contains the line breaks; this
          text is what people select by hand and what the setup checks read,
          so it has to be the file exactly as written. */}
      <pre
        aria-labelledby={labelId}
        data-testid={testId}
        tabIndex={0}
        className={`mt-1 overflow-x-auto rounded-[var(--radius-control)] border border-grey-200 bg-grey-100 p-3 font-mono text-xs text-ink ${multiline ? 'whitespace-pre-wrap break-all' : 'whitespace-pre-wrap [overflow-wrap:anywhere]'}`}
      >
        {value}
      </pre>
      {failed ? <ErrorNote className="mt-1">Could not copy. Select the text and copy it manually.</ErrorNote> : null}
    </div>
  )
}
