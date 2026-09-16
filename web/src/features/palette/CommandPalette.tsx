import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'

import { api, listAllWorkspaceIssues } from '../../lib/api'
import type { Issue, Membership, Milestone, Role } from '../../lib/types'
import { COMMAND_PALETTE_TEST_IDS } from './paletteTestIds'

const ISSUE_KEY_PATTERN = /^[a-z][a-z0-9]{1,9}-\d+$/i
const ISSUE_NUMBER_PATTERN = /^\d+$/

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
  onBack,
  onCreated,
}: {
  slug: string
  onBack: () => void
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
      className="space-y-4"
      onSubmit={(event) => void submit(event)}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs tracking-wide text-grey-500 uppercase">Command</p>
          <h2 className="text-base">New issue</h2>
        </div>
        <button
          type="button"
          className="rounded-[6px] px-2 py-1 text-sm text-grey-500 hover:bg-grey-100 hover:text-ink"
          onClick={onBack}
        >
          Back
        </button>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-grey-500">Title</span>
        <input
          data-testid={COMMAND_PALETTE_TEST_IDS.newIssueTitle}
          className="w-full border border-grey-300 bg-paper px-2 py-1.5 text-sm"
          autoFocus
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block text-grey-500">Milestone <span className="text-grey-500">(optional)</span></span>
        <select
          data-testid={COMMAND_PALETTE_TEST_IDS.newIssueMilestone}
          className="w-full border border-grey-300 bg-paper px-2 py-1.5 text-sm"
          value={milestoneId}
          onChange={(event) => setMilestoneId(event.target.value)}
          disabled={loadingMilestones}
        >
          <option value="">No milestone</option>
          {milestones.map((milestone) => (
            <option key={milestone.id} value={milestone.id}>
              {milestone.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-[6px] border border-ink bg-ink px-3 py-1.5 text-sm text-paper hover:bg-grey-700 disabled:opacity-40"
          disabled={saving || !title.trim()}
        >
          {saving ? 'Creating…' : 'Create issue'}
        </button>
        {error ? <p className="text-sm text-blocked" role="alert">Could not create issue. Try again.</p> : null}
      </div>
    </form>
  )
}

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
  const inputRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [issuePrefix, setIssuePrefix] = useState('ENG')
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [issueResults, setIssueResults] = useState<Issue[]>([])
  const [searching, setSearching] = useState(false)
  const [newIssueOpen, setNewIssueOpen] = useState(false)

  const canWrite = role === 'admin' || role === 'member'

  useEffect(() => {
    function onGlobalKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onOpenChange(true)
        return
      }

      if (open && event.key === 'Escape') {
        event.preventDefault()
        setNewIssueOpen(false)
        setQuery('')
        setIssueResults([])
        setSearching(false)
        setSelectedIndex(0)
        onOpenChange(false)
      }
    }

    document.addEventListener('keydown', onGlobalKeyDown)
    return () => document.removeEventListener('keydown', onGlobalKeyDown)
  }, [onOpenChange, open])

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      inputRef.current?.focus()
      return
    }

    inputRef.current?.blur()
    previousFocusRef.current?.focus()
  }, [open])

  useEffect(() => {
    const trimmed = query.trim()
    if (!open || !trimmed || ISSUE_KEY_PATTERN.test(trimmed)) {
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      void listAllWorkspaceIssues(slug)
        .then((result) => {
          if (cancelled) return
          const prefix = result.find((issue) => issue.key.includes('-'))?.key.split('-')[0]
          if (prefix) setIssuePrefix(prefix)
          setIssueResults(result)
          setSelectedIndex(0)
        })
        .catch(() => {
          if (!cancelled) setIssueResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query, slug])

  const commands = useMemo<PaletteCommand[]>(() => {
    const base = `/w/${slug}`
    const items: PaletteCommand[] = [
      { id: 'dashboard', label: 'Dashboard', keywords: ['home'], run: () => navigate(base) },
      { id: 'issues', label: 'Issues', keywords: ['tickets', 'work'], run: () => navigate(`${base}/issues`) },
      { id: 'feed', label: 'Team feed', keywords: ['activity'], run: () => navigate(`${base}/feed`) },
      { id: 'sprints', label: 'Sprints', keywords: ['iterations'], run: () => navigate(`${base}/sprints`) },
      { id: 'mentions', label: 'Mentions', keywords: ['notifications'], run: () => navigate(`${base}/mentions`) },
      { id: 'unlinked', label: 'Unlinked PRs', keywords: ['pull requests', 'evidence'], run: () => navigate(`${base}/unlinked`) },
      { id: 'reports', label: 'Reports', keywords: ['analytics'], run: () => navigate(`${base}/reports`) },
      ...(role === 'admin'
        ? [{ id: 'admin', label: 'Administration', keywords: ['settings'], run: () => navigate(`${base}/admin`) }]
        : []),
      { id: 'profile', label: 'Profile', keywords: ['account', 'settings'], run: () => navigate(`${base}/settings/profile`) },
      ...(canWrite
        ? [{
            id: 'new-issue',
            label: 'New issue',
            keywords: ['create', 'ticket'],
            run: () => {
              setQuery('')
              setIssueResults([])
              setSearching(false)
              setSelectedIndex(0)
              setNewIssueOpen(true)
            },
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

  const results = useMemo(() => {
    const trimmed = query.trim()
    const staticResults = commands.flatMap((command) => {
      const score = matchScore(command, trimmed)
      return score === null ? [] : [{ ...command, score }]
    })

    const issueCommands = issueResults.flatMap((issue) => {
      const command: PaletteCommand = {
        id: `issue-${issue.id}`,
        label: `${issue.key} ${issue.title}`,
        detail: issue.title,
        keywords: [issue.key, issue.title],
        run: () => navigate(`/w/${slug}/issues/${issue.key}`),
      }
      const score = matchScore(command, trimmed)
      return score === null ? [] : [{ ...command, score: score + 1 }]
    })

    const directMatch = trimmed.match(ISSUE_KEY_PATTERN)
    const numberMatch = trimmed.match(ISSUE_NUMBER_PATTERN)
    const matchingNumber = numberMatch
      ? issueResults.find((issue) => issue.number === Number(numberMatch[0]))
      : undefined
    const directKey = directMatch?.[0].toUpperCase()
      ?? matchingNumber?.key
      ?? (numberMatch ? `${issuePrefix}-${numberMatch[0]}` : undefined)
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
  }, [commands, issuePrefix, issueResults, navigate, query, slug])

  function close() {
    setNewIssueOpen(false)
    setQuery('')
    setIssueResults([])
    setSearching(false)
    setSelectedIndex(0)
    onOpenChange(false)
  }

  function runResult(result: PaletteResult) {
    result.run()
    if (result.id !== 'new-issue') close()
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      setSelectedIndex((index) => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      setSelectedIndex((index) => (index - 1 + results.length) % results.length)
    } else if (event.key === 'Home' && results.length > 0) {
      event.preventDefault()
      setSelectedIndex(0)
    } else if (event.key === 'End' && results.length > 0) {
      event.preventDefault()
      setSelectedIndex(results.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const result = results[selectedIndex]
      if (result) runResult(result)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  if (!open) return null

  const selected = results[selectedIndex]

  return (
    <div
      data-testid={COMMAND_PALETTE_TEST_IDS.root}
      className="fixed inset-0 z-50"
      data-palette-open="true"
    >
      <div
        data-testid={COMMAND_PALETTE_TEST_IDS.backdrop}
        className="absolute inset-0 bg-ink/30"
        aria-hidden="true"
        onClick={close}
      />
      <div
        className="relative z-10 mx-3 mt-[16vh] overflow-hidden rounded-[8px] border border-grey-300 bg-paper shadow-[0_16px_40px_rgba(0,0,0,0.16)] sm:mx-auto sm:mt-[18vh] sm:max-w-[34rem]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
      >
        {newIssueOpen ? (
          <div className="p-4">
            <NewIssueForm
              slug={slug}
              onBack={() => setNewIssueOpen(false)}
              onCreated={(issue) => {
                close()
                navigate(`/w/${slug}/issues/${issue.key}`)
              }}
            />
          </div>
        ) : (
          <>
            <div className="border-b border-grey-200 p-3">
              <h2 id="command-palette-title" className="sr-only">Command palette</h2>
              <input
                ref={inputRef}
                data-testid={COMMAND_PALETTE_TEST_IDS.input}
                role="combobox"
                aria-label="Command palette"
                aria-controls={COMMAND_PALETTE_TEST_IDS.results}
                aria-expanded="true"
                aria-activedescendant={selected ? `command-palette-option-${selected.id}` : undefined}
                autoComplete="off"
                className="w-full border-0 bg-transparent px-1 py-1 text-base text-ink placeholder:text-grey-500"
                placeholder="Search commands or issues"
                value={query}
                onChange={(event) => {
                  const nextQuery = event.target.value
                  setQuery(nextQuery)
                  setIssueResults([])
                  setSearching(Boolean(nextQuery.trim()) && !ISSUE_KEY_PATTERN.test(nextQuery.trim()))
                  setSelectedIndex(0)
                }}
                onKeyDown={onInputKeyDown}
              />
            </div>

            <div className="flex items-center justify-between px-4 pt-2 text-xs text-grey-500">
              <span>{results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No results'}</span>
              {searching ? <span data-testid={COMMAND_PALETTE_TEST_IDS.searching} aria-live="polite">Searching…</span> : null}
            </div>

            <div
              id={COMMAND_PALETTE_TEST_IDS.results}
              data-testid={COMMAND_PALETTE_TEST_IDS.results}
              className="max-h-80 overflow-y-auto p-2"
              role="listbox"
              aria-label="Command results"
            >
              {results.length > 0 ? results.map((result, index) => (
                <button
                  key={result.id}
                  id={`command-palette-option-${result.id}`}
                  data-testid={COMMAND_PALETTE_TEST_IDS.item}
                  data-command-id={result.id}
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  className={`flex w-full items-center gap-3 rounded-[6px] px-3 py-2 text-left text-sm ${
                    index === selectedIndex ? 'bg-grey-100 text-ink' : 'text-grey-700 hover:bg-grey-100'
                  }`}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => runResult(result)}
                >
                  <span className="min-w-0 flex-1 truncate">{result.label}</span>
                  {result.detail ? <span className="max-w-[11rem] truncate text-xs text-grey-500">{result.detail}</span> : null}
                </button>
              )) : (
                <p data-testid="command-palette-empty" className="px-3 py-6 text-center text-sm text-grey-500">
                  Try a command, issue key, or title.
                </p>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-grey-200 px-4 py-2 text-xs text-grey-500">
              <span>↑↓ to navigate</span>
              <span>Enter to open · Esc to close</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
