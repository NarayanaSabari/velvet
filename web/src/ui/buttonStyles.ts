export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-ink bg-ink text-paper hover:bg-grey-700',
  secondary: 'border-grey-300 bg-paper text-ink hover:bg-grey-100',
  // Red is one of the three semantic colours: destructive, and only destructive.
  danger: 'border-blocked bg-paper text-blocked hover:bg-grey-100',
  ghost: 'border-transparent bg-transparent text-ink hover:bg-grey-100',
}

export function buttonClassName(variant: ButtonVariant = 'secondary', className = '') {
  return `ui-button rounded-[6px] border px-2 py-1 text-sm disabled:opacity-40 ${VARIANTS[variant]} ${className}`
}
