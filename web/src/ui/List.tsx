import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface ListProps<T> {
  items: T[]
  keyExtractor: (item: T) => string
  renderItem: (item: T, active: boolean) => ReactNode
  onActivate?: (item: T) => void
  ariaLabel?: string
}

export function List<T>({
  items,
  keyExtractor,
  renderItem,
  onActivate,
  ariaLabel,
}: ListProps<T>) {
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLUListElement>(null)

  useEffect(() => {
    // Keep the cursor inside the list when items are filtered away underneath it.
    setIndex((i) => Math.min(i, Math.max(items.length - 1, 0)))
  }, [items.length])

  const active = items[index]
  const activeId = active ? `list-item-${keyExtractor(active)}` : undefined

  return (
    <ul
      ref={ref}
      role="listbox"
      aria-label={ariaLabel}
      aria-activedescendant={activeId}
      tabIndex={0}
      className="divide-y divide-grey-200 border-y border-grey-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
      onKeyDown={(e) => {
        if (e.key === 'j' || e.key === 'ArrowDown') {
          // preventDefault only on keys actually handled, so an unhandled key
          // still scrolls the page normally.
          e.preventDefault()
          setIndex((i) => Math.min(i + 1, items.length - 1))
        } else if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault()
          setIndex((i) => Math.max(i - 1, 0))
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const item = items[index]
          if (item && onActivate) onActivate(item)
        }
      }}
    >
      {items.map((item, i) => {
        const key = keyExtractor(item)
        const isActive = i === index
        return (
          <li
            key={key}
            id={`list-item-${key}`}
            role="option"
            aria-selected={isActive}
            onClick={() => {
              setIndex(i)
              onActivate?.(item)
            }}
            className={`cursor-default border-l-2 px-2 py-1 hover:bg-grey-100 ${
              isActive ? 'border-l-ink' : 'border-l-transparent'
            }`}
          >
            {renderItem(item, isActive)}
          </li>
        )
      })}
    </ul>
  )
}
