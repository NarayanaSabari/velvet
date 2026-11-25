import { Children, isValidElement, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import { Button as AstryxButton } from '@astryxdesign/core/Button'

import type { ButtonVariant } from './buttonStyles'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  ref?: Ref<HTMLButtonElement>
}

const ASTRYX_VARIANT = {
  primary: 'primary',
  secondary: 'secondary',
  ghost: 'ghost',
  danger: 'destructive',
} as const

/** The words inside a node, for the accessible name Astryx requires. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return Children.toArray(node).map(textOf).join('')
}

/**
 * Velvet's button, drawn by Astryx. The props stay those of a native button
 * so call sites did not change; this maps them onto Astryx's.
 *
 * Astryx disables with `aria-disabled` alone, which leaves the button in the
 * tab order. Velvet also sets the native `disabled`, because its forms rely
 * on a disabled submit button to stop a second submission, including the one
 * a browser makes when Enter is pressed in a field.
 */
export function Button({
  variant = 'secondary',
  className = '',
  children,
  disabled = false,
  type = 'button',
  title,
  name,
  value,
  form,
  'aria-label': ariaLabel,
  // Native button attributes Astryx has no counterpart for.
  formAction: _formAction,
  formEncType: _formEncType,
  formMethod: _formMethod,
  formNoValidate: _formNoValidate,
  formTarget: _formTarget,
  autoFocus = false,
  ref,
  ...rest
}: ButtonProps) {
  const label = ariaLabel ?? textOf(children)
  // Astryx has no autoFocus, and Velvet's confirmations rely on it to put
  // focus on the safe choice, so it is done here when the button mounts.
  const own = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (autoFocus) own.current?.focus()
    // Only on mount, as the native attribute behaves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const setRef = (node: HTMLButtonElement | null) => {
    own.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }
  return (
    <AstryxButton
      {...(rest as Record<string, unknown>)}
      {...(disabled ? { disabled: true } : null)}
      ref={setRef}
      label={label}
      variant={ASTRYX_VARIANT[variant]}
      type={type}
      isDisabled={disabled}
      tooltip={title}
      name={name}
      value={value}
      form={form}
      // `ui-button` keeps the 44px touch target below the sm breakpoint.
      className={`ui-button ${className}`.trim()}
    >
      {children}
    </AstryxButton>
  )
}
