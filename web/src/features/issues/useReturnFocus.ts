import { useEffect, useRef } from 'react'

/** Returns focus to the toggle button when an inline editor closes. */
export function useReturnFocus(open: boolean) {
  // Button does not forward refs, so the ref sits on a wrapper span.
  const wrapper = useRef<HTMLSpanElement>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) wrapper.current?.querySelector('button')?.focus()
    wasOpen.current = open
  }, [open])
  return wrapper
}
