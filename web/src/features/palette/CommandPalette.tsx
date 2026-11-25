import { ErrorNote } from '../../ui/ErrorNote'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { CommandPalette as AstryxCommandPalette, CommandPaletteInput } from '@astryxdesign/core/CommandPalette'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Text } from '@astryxdesign/core/Text'

import { api } from '../../lib/api'
import { Button } from '../../ui/Button'
import { SelectField, TextField } from '../../ui/fields'
import type { Issue, Membership, Milestone, Role } from '../../lib/types'
import { COMMAND_PALETTE_TEST_IDS } from './paletteTestIds'

const ISSUE_KEY_PATTERN = /^[a-z][a-z0-9]{1,9}-\d+$/i
const ISSUE_NUMBER_PATTERN = /^\d+$/
/** A short pause before asking the server, so each keystroke is not a request. */
const SEARCH_DELAY_MS = 150

type Navigate = (to: string) => void

interface PaletteCommand {
  id: string
  label: string
  detail?: string
  keywords?: string[]
  run: () => void
}

interface PaletteResult extends PaletteCommand {
  score: number
}

/** A result as Astryx's palette lists it. */
interface PaletteItem {
  id: string
  label: string
  auxiliaryData: { detail?: string }
}

function normalise(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function matchScore(command: PaletteCommand, query: string): number | null {
  const needle = normalise(query)
  if (!needle) return 0

  const haystacks = [command.label, command.detail ?? '', ...(command.keywords ?? [])]
    .map(normalise)
    .filter(Boolean)

  if (haystacks.some((value) => value === needle)) return 0
  if (haystacks.some((value) => value.startsWith(needle))) return 1
  if (haystacks.some((value) => value.split(' ').some((word) => word.startsWith(needle)))) return 2
  if (haystacks.some((value) => value.includes(needle))) return 3

  // Keep fuzzy matching intentionally conservative so a short query does not
  // replace a useful prefix match with an unrelated command.
  for (const value of haystacks) {
    let cursor = 0
    let gaps = 0
    let matched = true
    for (const character of needle) {
      const found = value.indexOf(character, cursor)
      if (found === -1) {
        matched = false
        break
      }
      gaps += found - cursor
      cursor = found + 1
    }
    if (matched && gaps <= needle.length * 3) return 4
  }

  return null
}

function sortResults(results: PaletteResult[]) {
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => a.result.score - b.result.score || a.index - b.index)
    .map(({ result }) => result)
}

function NewIssueForm({
  slug,
  onCreated,
}: {
  slug: string
  onCreated: (issue: Issue) => void
}) {
  const [title, setTitle] = useState('')
  const [milestoneId, setMilestoneId] = useState('')
  const [milestones, setMilestones] = useState<Milestone[]>([])
  const [loadingMilestones, setLoadingMilestones] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .get<{ milestones: Milestone[] }>(`/w/${slug}/milestones`)
      .then((result) => {
        if (!cancelled) setMilestones(result.milestones)
      })
      .catch(() => {
        if (!cancelled) setMilestones([])
      })
      .finally(() => {
        if (!cancelled) setLoadingMilestones(false)
      })

    return () => {
      cancelled = true
    }
  }, [slug])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedTitle = title.trim()
    if (!trimmedTitle || saving) return

    setSaving(true)
    setError(false)
    try {
      const issue = await api.post<Issue>(`/w/${slug}/issues`, {
        title: trimmedTitle,
        description: '',
        status: 'backlog',
        priority: 0,
        ...(milestoneId ? { milestone_id: milestoneId } : {}),
      })
      onCreated(issue)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      data-testid={COMMAND_PALETTE_TEST_IDS.newIssueForm}
      className="space-y-4 p-4"
      onSubmit={(event) => void submit(event)}
    >
      <TextField
        data-testid={COMMAND_PALETTE_TEST_IDS.newIssueTitle}
        label="Title"
        autoFocus
        required
        value={title}
        onChange={setTitle}
      />
      <SelectField
        data-testid={COMMAND_PALETTE_TEST_IDS.newIssueMilestone}
        label="Milestone (optional)"
        value={milestoneId}
        disabled={loadingMilestones}
        onChange={setMilestoneId}
        options={[
          { value: '', label: 'No milestone' },
          ...milestones.map((milestone) => ({ value: milestone.id, label: milestone.name })),
        ]}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={saving || !title.trim()}>
          {saving ? 'Creating…' : 'Create issue'}
        </Button>
        {error ? <ErrorNote>Could not create issue. Try again.</ErrorNote> : null}
      </div>
    </form>
  )
}

/**
 * Search and commands, drawn by Astryx's command palette. Velvet supplies the
 * results: its own commands, ranked by how well they match, plus issues the
 * server finds by key, title or description.
 */
export function CommandPalette({
  open,
  onOpenChange,
  slug,
  role,
  memberships,
  navigate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  slug: string
  role: Role
  memberships: Membership[]
  navigate: Navigate
}) {
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  // Every result offered so far, by id, so a chosen row can be run.
  const shown = useRef(new Map<string, PaletteCommand>())
  const issuePrefix = useRef('ENG')
  const latestSearch = useRef(0)

  const canWrite = role === 'admin' || role === 'member'

  useEffect(() => {
    function onGlobalKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onOpenChange(true)
      }
    }

    document.addEventListener('keydown', onGlobalKeyDown)
    return () => document.removeEventListener('keydown', onGlobalKeyDown)
  }, [onOpenChange])

  const commands = useMemo<PaletteCommand[]>(() => {
    const base = `/w/${slug}`
    const items: PaletteCommand[] = [
      { id: 'dashboard', label: 'Dashboard', keywords: ['home'], run: () => navigate(base) },
      { id: 'issues', label: 'Issues', keywords: ['tickets', 'work'], run: () => navigate(`${base}/issues`) },
      { id: 'projects', label: 'Projects', keywords: ['repositories', 'products'], run: () => navigate(`${base}/projects`) },
      { id: 'feed', label: 'Team feed', keywords: ['activity'], run: () => navigate(`${base}/feed`) },
      { id: 'sprints', label: 'Sprints', keywords: ['iterations'], run: () => navigate(`${base}/sprints`) },
      { id: 'mentions', label: 'Mentions', keywords: ['notifications'], run: () => navigate(`${base}/mentions`) },
      { id: 'unlinked', label: 'Unlinked PRs', keywords: ['pull requests', 'evidence'], run: () => navigate(`${base}/unlinked`) },
      { id: 'reports', label: 'Reports', keywords: ['analytics'], run: () => navigate(`${base}/reports`) },
      ...(role === 'admin'
        ? [
            { id: 'admin', label: 'Administration', keywords: ['settings', 'organisation', 'rename'], run: () => navigate(`${base}/admin/general`) },
            { id: 'admin-members', label: 'Members', keywords: ['administration', 'people', 'roles', 'team'], run: () => navigate(`${base}/admin/members`) },
            { id: 'admin-invitations', label: 'Invitations', keywords: ['administration', 'invite', 'email'], run: () => navigate(`${base}/admin/invitations`) },
            { id: 'admin-repositories', label: 'Repositories', keywords: ['administration', 'github', 'repos', 'sync'], run: () => navigate(`${base}/admin/repositories`) },
          ]
        : []),
      { id: 'profile', label: 'Profile', keywords: ['account', 'settings'], run: () => navigate(`${base}/settings/profile`) },
      { id: 'worklog', label: 'My work log', keywords: ['worklog', 'time', 'history', 'across organisations'], run: () => navigate('/me/worklog') },
      { id: 'agent-config', label: 'Agent config', keywords: ['connect', 'coding agent', 'cli', 'velvet init', 'repository', 'claude', 'codex', 'cursor'], run: () => navigate(`${base}/settings/profile/agent-config`) },
      ...(canWrite
        ? [{
            id: 'new-issue',
            label: 'New issue',
            keywords: ['create', 'ticket'],
            run: () => setNewIssueOpen(true),
          }]
        : []),
      ...(memberships.length > 1
        ? memberships.map((membership) => ({
            id: `workspace-${membership.id}`,
            label: `Switch to ${membership.workspace_name}`,
            detail: membership.workspace_slug === slug ? 'Current organisation' : membership.workspace_slug,
            keywords: ['organisation', 'workspace', membership.workspace_slug],
            run: () => navigate(`/w/${membership.workspace_slug}`),
          }))
        : []),
    ]
    return items
  }, [canWrite, memberships, navigate, role, slug])

  const searchSource = useMemo(() => {
    function toItems(results: PaletteResult[]): PaletteItem[] {
      // Added to, never replaced: an older search can finish after a newer
      // one, and must not make the rows on screen impossible to run.
      for (const result of results) shown.current.set(result.id, result)
      return results.map((result) => ({ id: result.id, label: result.label, auxiliaryData: { detail: result.detail } }))
    }

    function rank(query: string, issues: Issue[]): PaletteResult[] {
      const trimmed = query.trim()
      const staticResults = commands.flatMap((command) => {
        const score = matchScore(command, trimmed)
        return score === null ? [] : [{ ...command, score }]
      })

      const issueCommands = issues.map((issue) => {
        const command: PaletteCommand = {
          id: `issue-${issue.id}`,
          label: `${issue.key} ${issue.title}`,
          keywords: [issue.key, issue.title],
          run: () => navigate(`/w/${slug}/issues/${issue.key}`),
        }
        // The server already matched the query, including in descriptions the
        // palette cannot see, so keep every result it returned.
        return { ...command, score: (matchScore(command, trimmed) ?? 4) + 1 }
      })

      const directMatch = trimmed.match(ISSUE_KEY_PATTERN)
      const numberMatch = trimmed.match(ISSUE_NUMBER_PATTERN)
      const matchingNumber = numberMatch
        ? issues.find((issue) => issue.number === Number(numberMatch[0]))
        : undefined
      const directKey = directMatch?.[0].toUpperCase()
        ?? matchingNumber?.key
        ?? (numberMatch ? `${issuePrefix.current}-${numberMatch[0]}` : undefined)
      const directResult: PaletteResult[] = directKey
        ? [{
            id: `go-to-${directKey.toLowerCase()}`,
            label: `Go to ${directKey}`,
            detail: 'Open issue',
            keywords: [directKey],
            score: -1,
            run: () => navigate(`/w/${slug}/issues/${directKey}`),
          }]
        : []

      return sortResults([...directResult, ...staticResults, ...issueCommands])
    }

    return {
      bootstrap: () => toItems(rank('', [])),
      search: async (query: string, context?: { update: (items: PaletteItem[]) => void }) => {
        const trimmed = query.trim()
        const search = ++latestSearch.current
        // A full issue key needs no search: it is offered directly.
        if (!trimmed || ISSUE_KEY_PATTERN.test(trimmed)) return toItems(rank(query, []))

        // Commands match at once; issues from the server are added after them.
        context?.update(toItems(rank(query, [])))
        await new Promise((resolve) => window.setTimeout(resolve, SEARCH_DELAY_MS))
        // Typing moved on while this one waited, so it asks the server nothing.
        if (search !== latestSearch.current) return toItems(rank(query, []))

        let issues: Issue[] = []
        try {
          // The server filters by key, title, and description, so only one small
          // page crosses the wire instead of every issue in the organisation.
          const params = new URLSearchParams({ q: trimmed, limit: '20' })
          issues = (await api.get<{ issues: Issue[] }>(`/w/${slug}/issues?${params.toString()}`)).issues
        } catch {
          issues = []
        }
        const prefix = issues.find((issue) => issue.key.includes('-'))?.key.split('-')[0]
        if (prefix) issuePrefix.current = prefix
        if (search !== latestSearch.current) return toItems(rank(query, []))
        return toItems(rank(query, issues))
      },
    }
  }, [commands, navigate, slug])

  function choose(id: string) {
    const command = shown.current.get(id)
    if (!command) return
    onOpenChange(false)
    command.run()
  }

  return (
    <>
      <AstryxCommandPalette<PaletteItem>
        isOpen={open}
        onOpenChange={onOpenChange}
        searchSource={searchSource}
        onValueChange={choose}
        label="Command palette"
        width="min(34rem, calc(100vw - 1.5rem))"
        input={(
          // Enter with nothing highlighted runs the top result, so typing a
          // few letters and pressing Enter is enough. Once an arrow key has
          // highlighted a row, Astryx's own handling chooses it.
          <div
            onKeyDownCapture={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              const field = event.target as HTMLElement
              if (field.getAttribute('aria-activedescendant')) return
              const first = field.closest('dialog')?.querySelector<HTMLElement>('[role="option"] [data-command-id]')
              if (!first?.dataset.commandId) return
              event.preventDefault()
              event.stopPropagation()
              choose(first.dataset.commandId)
            }}
          >
            <CommandPaletteInput label="Command palette" placeholder="Search commands or issues" />
          </div>
        )}
        emptySearchText="Try a command, issue key, or title."
        renderItem={(item) => (
          <span className="flex min-w-0 items-baseline gap-3" data-command-id={item.id}>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.auxiliaryData.detail ? (
              <Text type="supporting" color="secondary" className="max-w-[11rem] shrink-0 truncate">{item.auxiliaryData.detail}</Text>
            ) : null}
          </span>
        )}
      />
      <Dialog isOpen={newIssueOpen} onOpenChange={setNewIssueOpen} purpose="form" width="min(30rem, calc(100vw - 1.5rem))" padding={0}>
        <DialogHeader title="New issue" onOpenChange={setNewIssueOpen} />
        {newIssueOpen ? (
          <NewIssueForm
            slug={slug}
            onCreated={(issue) => {
              setNewIssueOpen(false)
              navigate(`/w/${slug}/issues/${issue.key}`)
            }}
          />
        ) : null}
      </Dialog>
    </>
  )
}
