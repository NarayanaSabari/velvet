// Loaded after index.css, which declares the cascade-layer order these
// stylesheets depend on.
import type { DefinedTheme } from '@astryxdesign/core/theme'

import { themes } from '../astryx-themes'
import { velvetTheme } from '../themes/velvet/velvet.js'
import '../themes/velvet/velvet.css'

/**
 * The looks the app can wear while Astryx is being adopted.
 * `velvet` is the app's own monochrome look as an Astryx theme (built from
 * src/themes/velvet/velvetTheme.ts). `neutral` is Astryx's stock theme.
 */
export const LOOKS = { velvet: velvetTheme, neutral: themes.neutral } satisfies Record<string, DefinedTheme>
export type Look = keyof typeof LOOKS
export const DEFAULT_LOOK: Look = 'velvet'

const STORAGE_KEY = 'velvet.look'

function isLook(value: string | null): value is Look {
  return value !== null && Object.hasOwn(LOOKS, value)
}

/**
 * `?look=neutral` or `?look=velvet` picks a look and keeps it for the rest of
 * the browser tab, so two tabs or frames can show the two side by side.
 */
export function currentLook(): Look {
  try {
    const requested = new URLSearchParams(window.location.search).get('look')
    if (isLook(requested)) {
      window.sessionStorage.setItem(STORAGE_KEY, requested)
      return requested
    }
    const remembered = window.sessionStorage.getItem(STORAGE_KEY)
    if (isLook(remembered)) return remembered
  } catch {
    // Storage can be unavailable; the default look still applies.
  }
  return DEFAULT_LOOK
}
