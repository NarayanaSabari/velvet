import type { ButtonHTMLAttributes } from 'react'

import { buttonClassName, type ButtonVariant } from './buttonStyles'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

export function Button({ variant = 'secondary', className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={buttonClassName(variant, className)}
      {...rest}
    />
  )
}
