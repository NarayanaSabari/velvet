export const PRIORITIES = [0, 1, 2, 3, 4] as const

/** Option text for a priority picker. The API and CLI define 0 as "none"; 1 to 4 carry no documented order. */
export function priorityOption(value: number): string {
  return value === 0 ? 'P0 (none)' : `P${value}`
}
