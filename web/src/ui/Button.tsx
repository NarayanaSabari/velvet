import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'border-ink bg-ink text-paper hover:opacity-80',
  ghost: 'border-grey-300 bg-paper text-ink hover:bg-grey-100',
  // Red is one of the three semantic colours: destructive, and only destructive.
  danger: 'border-blocked bg-paper text-blocked hover:bg-grey-100',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
}

export function Button({ variant = 'ghost', className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`border px-2 py-1 text-sm transition-colors disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  )
}
