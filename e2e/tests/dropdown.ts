import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Velvet's dropdowns are Astryx pop-up lists, not native selects, so
 * Playwright's selectOption does not apply. A dropdown is a button with the
 * role combobox; its list opens on click.
 */

/** A dropdown by its label. */
export function dropdown(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('combobox', { name, exact: true })
}

/** Choose by value, or by the label a person sees with `{ label }`. */
export async function chooseOption(control: Locator, choice: string | { label: string }): Promise<void> {
  const listId = await control.getAttribute('aria-controls')
  if (!listId) throw new Error('the dropdown has no option list')
  const list = control.page().locator(`[id="${listId}"]`)
  await control.click()
  if (typeof choice === 'string') {
    const values = JSON.parse((await control.getAttribute('data-option-values')) ?? '[]') as string[]
    const index = values.indexOf(choice)
    if (index < 0) throw new Error(`no option "${choice}"; the dropdown offers ${JSON.stringify(values)}`)
    await list.getByRole('option').nth(index).click()
  } else {
    await list.getByRole('option', { name: choice.label, exact: true }).click()
  }
}

/** The dropdown shows this choice. */
export async function expectChosen(control: Locator, label: string): Promise<void> {
  await expect(control).toHaveText(label)
}
