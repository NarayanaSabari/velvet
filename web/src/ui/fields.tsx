import { useId, type ReactNode } from 'react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { Field } from '@astryxdesign/core/Field'
import { Selector } from '@astryxdesign/core/Selector'
import { TextArea } from '@astryxdesign/core/TextArea'
import { TextInput } from '@astryxdesign/core/TextInput'

/**
 * Velvet's form fields, drawn by Astryx.
 *
 * Each takes a `label`, which Astryx always renders for assistive technology
 * and shows above the control unless `hideLabel` is set. Values are plain
 * strings (or a boolean for a checkbox) and `onChange` receives the new value,
 * not an event.
 */

/** Attributes passed straight through to the control itself. */
interface ControlAttributes {
  'aria-label'?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  name?: string
  [key: `data-${string}`]: string | undefined
}

interface FieldBase extends ControlAttributes {
  label: string
  /** Keep the label for assistive technology but do not show it. */
  hideLabel?: boolean
  description?: string
  disabled?: boolean
  className?: string
}

/** `ui-field` gives the control a 44px touch target below the sm breakpoint. */
function Shell({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`ui-field min-w-0 ${className}`.trim()}>{children}</div>
}

export interface TextFieldProps extends FieldBase {
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'email' | 'search' | 'password' | 'url' | 'tel'
  placeholder?: string
  /** Native validation: the browser blocks submitting the form while empty. */
  required?: boolean
  autoFocus?: boolean
  autoComplete?: string
  minLength?: number
  maxLength?: number
  pattern?: string
  inputMode?: 'none' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | 'search'
  /** Turn off spell checking and automatic capitals, for codes and addresses. */
  literal?: boolean
  /** Monospaced text, for keys and codes. */
  mono?: boolean
  size?: 'md' | 'lg'
  readOnly?: boolean
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
}

export function TextField({
  label, hideLabel = false, description, disabled = false, className,
  value, onChange, type = 'text', placeholder, required = false, autoFocus = false,
  autoComplete, minLength, maxLength, pattern, inputMode, literal = false, mono = false, size = 'md',
  readOnly = false, onKeyDown, name, ...attributes
}: TextFieldProps) {
  return (
    <Shell className={`${mono ? '[&_input]:font-mono' : ''} ${className ?? ''}`.trim()}>
      <TextInput
        {...(attributes as Record<string, unknown>)}
        {...(required ? { required: true } : null)}
        {...(minLength !== undefined ? { minLength } : null)}
        {...(maxLength !== undefined ? { maxLength } : null)}
        {...(pattern !== undefined ? { pattern } : null)}
        {...(literal ? { spellCheck: false, autoCapitalize: 'none' } : null)}
        inputMode={inputMode}
        size={size}
        label={label}
        isLabelHidden={hideLabel}
        description={description}
        value={value}
        onChange={(next) => onChange(next)}
        type={type}
        placeholder={placeholder}
        hasAutoFocus={autoFocus}
        autoComplete={autoComplete}
        isDisabled={disabled}
        isReadOnly={readOnly}
        onKeyDown={onKeyDown}
        htmlName={name}
        width="100%"
      />
    </Shell>
  )
}

export interface TextAreaFieldProps extends FieldBase {
  value: string
  onChange: (value: string) => void
  rows?: number
  placeholder?: string
  required?: boolean
  autoFocus?: boolean
  readOnly?: boolean
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  ref?: React.Ref<HTMLTextAreaElement>
}

export function TextAreaField({
  label, hideLabel = false, description, disabled = false, className,
  value, onChange, rows = 3, placeholder, required = false, autoFocus = false,
  readOnly = false, onKeyDown, onPaste, ref, name, ...attributes
}: TextAreaFieldProps) {
  return (
    <Shell className={className}>
      <TextArea
        {...(attributes as Record<string, unknown>)}
        {...(required ? { required: true } : null)}
        {...(onKeyDown ? { onKeyDown } : null)}
        ref={ref}
        label={label}
        isLabelHidden={hideLabel}
        description={description}
        value={value}
        onChange={(next) => onChange(next)}
        rows={rows}
        placeholder={placeholder}
        hasAutoFocus={autoFocus}
        isDisabled={disabled}
        isReadOnly={readOnly}
        onPaste={onPaste}
        htmlName={name}
        width="100%"
      />
    </Shell>
  )
}

export interface SelectChoice {
  value: string
  label: string
  disabled?: boolean
}

/** One choice, or a titled group of choices. */
export type SelectOption = SelectChoice | { group: string; options: SelectChoice[] }

export interface SelectFieldProps extends FieldBase {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  autoFocus?: boolean
  size?: 'md' | 'lg'
  /** A hover title on the control, such as what the chosen value means. */
  title?: string
  /** Shown under the control, in the error style. */
  error?: string
}

export function SelectField({
  label, hideLabel = false, description, disabled = false, className,
  value, onChange, options, placeholder, autoFocus = false, size = 'md', title, error, name, ...attributes
}: SelectFieldProps) {
  const choices = options.flatMap((option) => ('group' in option ? option.options : [option]))
  return (
    <Shell className={className}>
      <Selector
        {...(attributes as Record<string, unknown>)}
        {...(autoFocus ? { autoFocus: true } : null)}
        {...(title ? { title } : null)}
        size={size}
        // The chosen value and the choices on offer, readable from the page.
        // The option list is a pop-up, so tests and scripts drive it by these.
        data-value={value}
        data-option-values={JSON.stringify(choices.map((choice) => choice.value))}
        label={label}
        isLabelHidden={hideLabel}
        description={description}
        // A value that is not on offer, such as an empty one before anything
        // is chosen, shows the placeholder instead.
        value={choices.some((choice) => choice.value === value) ? value : undefined}
        onChange={(next) => onChange(next ?? '')}
        options={options.map((option) =>
          'group' in option
            ? { type: 'section' as const, title: option.group, options: option.options }
            : option,
        )}
        placeholder={placeholder}
        isDisabled={disabled}
        status={error ? { type: 'error', message: error } : undefined}
        htmlName={name}
        width="100%"
      />
    </Shell>
  )
}

export interface CheckboxFieldProps extends Omit<FieldBase, 'hideLabel'> {
  checked: boolean
  onChange: (checked: boolean) => void
}

export function CheckboxField({
  label, description, disabled = false, className, checked, onChange, name, ...attributes
}: CheckboxFieldProps) {
  return (
    <div className={className}>
      <CheckboxInput
        {...(attributes as Record<string, unknown>)}
        label={label}
        description={description}
        value={checked}
        onChange={(next) => onChange(next)}
        isDisabled={disabled}
        htmlName={name}
        size="sm"
      />
    </div>
  )
}

/**
 * Astryx's label and layout around a control it has no equivalent for, such
 * as the browser's date picker. The child receives the id the label points at.
 */
export function NativeField({ label, hideLabel = false, description, className, children }: {
  label: string
  hideLabel?: boolean
  description?: string
  className?: string
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <Shell className={className}>
      <Field label={label} inputID={id} isLabelHidden={hideLabel} description={description} width="100%">
        {children(id)}
      </Field>
    </Shell>
  )
}
