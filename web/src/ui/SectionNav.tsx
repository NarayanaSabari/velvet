import { List, ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'

export interface SectionNavItem {
  id: string
  label: string
  href: string
  /** A live count shown beside the label, such as the number of members. */
  count?: number
  /** Marks the one destructive section, which keeps its colour. */
  destructive?: boolean
}

/**
 * The list of pages beside a small settings area, such as Administration or
 * Profile. Each row is a link, and the page being shown is selected.
 */
export function SectionNav({ label, items, current }: {
  label: string
  items: SectionNavItem[]
  current: string
}) {
  return (
    <nav aria-label={label} className="lg:sticky lg:top-4">
      <List density="compact">
        {items.map((item) => (
          <ListItem
            key={item.id}
            itemKey={item.id}
            href={item.href}
            isSelected={item.id === current}
            label={(
              <span className="flex items-baseline justify-between gap-3">
                <span className={item.destructive ? 'text-blocked' : undefined}>{item.label}</span>
                {item.count !== undefined ? (
                  <Text type="supporting" color="secondary" className="tabular-nums">{item.count}</Text>
                ) : null}
              </span>
            )}
          />
        ))}
      </List>
    </nav>
  )
}
