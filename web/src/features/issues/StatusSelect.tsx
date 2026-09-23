import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import type { IssueStatus } from '../../lib/types'
import { STATUS_LABELS } from '../../ui/StatusBadge'

const ISSUE_STATUSES = Object.keys(STATUS_LABELS) as IssueStatus[]

const STATUS_DOT_TONES: Record<IssueStatus, string> = {
  backlog: 'bg-grey-300',
  todo: 'bg-grey-500',
  in_progress: 'bg-grey-700',
  in_review: 'bg-stale',
  done: 'bg-done',
  cancelled: 'bg-blocked',
}

export function StatusDot({ status }: { status: IssueStatus }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_TONES[status]}`}
    />
  )
}

/**
 * A compact listbox for changing an issue's status.
 *
 * The trigger keeps focus while the menu is open, which makes the keyboard
 * path predictable: arrows move the active option, Enter commits it, and
 * Escape closes without changing anything.
 */
export function StatusSelect({
  value,
  onChange,
  disabled,
}: {
  value: IssueStatus
  onChange: (status: IssueStatus) => void
  disabled?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(() => statusIndex(value))
  const [openedByKeyboard, setOpenedByKeyboard] = useState(false)
  const generatedId = useId()
  const listboxId = `status-listbox-options-${generatedId}`

  useEffect(() => {
    if (!open) return

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  function openMenu(byKeyboard: boolean, initialIndex = statusIndex(value)) {
    setActiveIndex(Math.max(0, Math.min(initialIndex, ISSUE_STATUSES.length - 1)))
    setOpenedByKeyboard(byKeyboard)
    setOpen(true)
  }

  function closeMenu() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function choose(status: IssueStatus) {
    if (status !== value) onChange(status)
    closeMenu()
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return

    if (!open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        openMenu(true, statusIndex(value) + 1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        openMenu(true, statusIndex(value) - 1)
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openMenu(true)
      }
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, ISSUE_STATUSES.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(ISSUE_STATUSES.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(activeStatus)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
    }
  }

  const activeStatus = ISSUE_STATUSES[activeIndex] ?? value

  return (
    <div ref={rootRef} className="relative" data-testid="issue-status-select">
      <style>{`
        @keyframes status-listbox-enter {
          from { opacity: 0; transform: scale(0.97); }
          to { opacity: 1; transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-status-listbox-options] { animation: none !important; }
        }
      `}</style>
      <button
        ref={triggerRef}
        type="button"
        data-testid="status-listbox"
        data-current-status={value}
        aria-label="Status"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-${activeStatus}` : undefined}
        disabled={disabled}
        className="ui-control inline-flex min-h-8 items-center gap-2 px-2 py-1 text-sm hover:bg-grey-100 disabled:cursor-not-allowed"
        onClick={() => {
          if (open) closeMenu()
          else openMenu(false)
        }}
        onKeyDown={onKeyDown}
      >
        <StatusDot status={value} />
        <span>{STATUS_LABELS[value]}</span>
        <span aria-hidden="true" className="text-grey-500">⌄</span>
      </button>

      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Status"
          data-testid="status-listbox-options"
          data-status-listbox-options
          className="absolute right-0 top-[calc(100%+0.375rem)] z-20 min-w-40 overflow-hidden rounded-[var(--radius-surface)] border border-grey-300 bg-paper py-1 shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
          style={{
            animation: openedByKeyboard
              ? 'none'
              : 'status-listbox-enter 150ms cubic-bezier(0.23, 1, 0.32, 1)',
            transformOrigin: 'top right',
          }}
        >
          {ISSUE_STATUSES.map((status, index) => (
            <li
              key={status}
              id={`${listboxId}-${status}`}
              role="option"
              aria-selected={status === value}
              data-testid={`status-option-${status}`}
              data-status={status}
              data-highlighted={index === activeIndex ? 'true' : undefined}
              className={`flex cursor-default items-center gap-2 px-2 py-1.5 text-sm ${
                index === activeIndex ? 'bg-grey-100' : ''
              }`}
              onClick={() => choose(status)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <StatusDot status={status} />
              <span>{STATUS_LABELS[status]}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function statusIndex(status: IssueStatus) {
  const index = ISSUE_STATUSES.indexOf(status)
  return index === -1 ? 0 : index
}
