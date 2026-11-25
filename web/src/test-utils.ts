import { screen, waitFor } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

/**
 * Astryx keeps a few empty live regions mounted for its own announcements:
 * one inside every button and link button, and a shared pair on the page once a spinner has
 * been shown. These helpers find the app's own status and alert messages
 * without tripping over those.
 */
function ownRegion(element: HTMLElement): boolean {
  // A link drawn as a button is an anchor, and carries the same empty region.
  return !element.hasAttribute('data-astryx-live-region') && element.closest('button, a') === null
}

function only(elements: HTMLElement[], role: string): HTMLElement {
  if (elements.length !== 1) throw new Error(`expected one ${role} of the page's own, found ${elements.length}`)
  return elements[0] as HTMLElement
}

export function pageStatus(): HTMLElement {
  return only(screen.queryAllByRole('status').filter(ownRegion), 'status')
}

export function pageAlert(): HTMLElement {
  return only(screen.queryAllByRole('alert').filter(ownRegion), 'alert')
}

export function findPageStatus(): Promise<HTMLElement> {
  return waitFor(pageStatus)
}

export function findPageAlert(): Promise<HTMLElement> {
  return waitFor(pageAlert)
}

/** The page's own status message, or null when it has none. */
export function queryPageStatus(): HTMLElement | null {
  return screen.queryAllByRole('status').filter(ownRegion)[0] ?? null
}

/** The page's own alert, or null when it has none. */
export function queryPageAlert(): HTMLElement | null {
  return screen.queryAllByRole('alert').filter(ownRegion)[0] ?? null
}

/**
 * Choose a value in one of Velvet's dropdowns, which are Astryx pop-up lists
 * and not native selects. `control` is the dropdown's button.
 */
export async function chooseOption(user: UserEvent, control: HTMLElement, value: string): Promise<void> {
  const values = JSON.parse(control.getAttribute('data-option-values') ?? '[]') as string[]
  const index = values.indexOf(value)
  if (index < 0) throw new Error(`no option "${value}"; the dropdown offers ${JSON.stringify(values)}`)
  const list = control.ownerDocument.getElementById(control.getAttribute('aria-controls') ?? '')
  if (!list) throw new Error('the dropdown has no option list')
  await user.click(control)
  const option = list.querySelectorAll<HTMLElement>('[role="option"]')[index]
  if (!option) throw new Error(`option ${index} is not in the list`)
  await user.click(option)
}

/** The labels a dropdown offers, in order. */
export function optionLabels(control: HTMLElement): string[] {
  const list = control.ownerDocument.getElementById(control.getAttribute('aria-controls') ?? '')
  return [...(list?.querySelectorAll('[role="option"]') ?? [])].map((option) => option.textContent ?? '')
}

/** One of Velvet's dropdowns, by its label. */
export function dropdown(name: string | RegExp): HTMLElement {
  return screen.getByRole('combobox', { name })
}

/** The pop-up list a dropdown opens, for checking its groups and choices. */
export function optionList(control: HTMLElement): HTMLElement {
  const list = control.ownerDocument.getElementById(control.getAttribute('aria-controls') ?? '')
  if (!list) throw new Error('the dropdown has no option list')
  return list
}

/** A dropdown that appears after data loads. */
export function findDropdown(name: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole('combobox', { name })
}
