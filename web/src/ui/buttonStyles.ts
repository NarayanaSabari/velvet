export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-ink bg-ink text-paper hover:bg-grey-700',
  secondary: 'border-grey-300 bg-paper text-ink hover:bg-grey-100',
  // Red is one of the three semantic colours: destructive, and only destructive.
  danger: 'border-blocked bg-paper text-blocked hover:bg-grey-100',
  ghost: 'border-transparent bg-transparent text-ink hover:bg-grey-100',
}

/** Disabled keeps readable text (grey-700) and signals itself with a dashed border, not with opacity. */
export const DISABLED_BUTTON =
  'disabled:cursor-not-allowed disabled:border-dashed disabled:border-grey-300 disabled:bg-transparent disabled:text-grey-700 disabled:hover:bg-transparent'

export function buttonClassName(variant: ButtonVariant = 'secondary', className = '') {
  return `ui-button rounded-[var(--radius-control)] border px-2.5 py-1 text-sm ${DISABLED_BUTTON} ${VARIANTS[variant]} ${className}`
}
