import { defineTheme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral'

/**
 * Velvet's look, expressed as an Astryx theme.
 *
 * The values are the palette in `src/index.css` and `design.md`: monochrome
 * ink on paper, with colour reserved for state. Each colour is a
 * [light, dark] pair, and dark inverts the same palette rather than adding a
 * second one.
 *
 * This is the source. After changing it, rebuild the files Astryx loads:
 *   pnpm exec astryx theme build src/themes/velvet/velvetTheme.ts
 */

const ink: [string, string] = ['#000000', '#ffffff']
const paper: [string, string] = ['#ffffff', '#0a0a0a']
const grey100: [string, string] = ['#f5f5f5', '#171717']
const grey200: [string, string] = ['#e5e5e5', '#262626']
const grey300: [string, string] = ['#d4d4d4', '#404040']
const grey500: [string, string] = ['#737373', '#a3a3a3']
const blocked: [string, string] = ['#b91c1c', '#f87171']
const stale: [string, string] = ['#b45309', '#fbbf24']
const done: [string, string] = ['#15803d', '#4ade80']

export const velvetTheme = defineTheme({
  name: 'velvet',
  extends: neutralTheme,

  // The system font stack, at the app's 16px reading size.
  typography: {
    scale: { base: 16, ratio: 1.125 },
    body: { family: 'ui-sans-serif', fallbacks: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
    heading: { family: 'ui-sans-serif', fallbacks: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  },

  tokens: {
    // The accent is ink: a primary action is an ink fill with paper text.
    '--color-accent': ink,
    '--color-on-accent': paper,
    '--color-accent-muted': grey200,
    '--color-text-accent': ink,
    '--color-icon-accent': ink,

    // Surfaces are paper. Grey 100 is the one quiet fill.
    '--color-background-body': paper,
    '--color-background-surface': paper,
    '--color-background-card': paper,
    '--color-background-popover': ['#ffffff', '#171717'],
    '--color-background-muted': grey100,
    '--color-background-inverted': ink,
    // The fill behind secondary buttons, neutral badges and avatar initials.
    // Grey 200, so each still reads as a shape on paper and on the sidebar.
    '--color-neutral': grey200,
    '--color-overlay-hover': ['#0000000a', '#ffffff0f'],
    '--color-overlay-pressed': ['#00000014', '#ffffff1a'],

    '--color-text-primary': ink,
    '--color-text-secondary': grey500,
    '--color-text-disabled': ['#a3a3a3', '#525252'],
    '--color-icon-primary': ink,
    '--color-icon-secondary': grey500,
    '--color-icon-disabled': ['#a3a3a3', '#525252'],

    '--color-border': grey200,
    '--color-border-emphasized': grey300,

    // State colours only: done, stale and blocked. Information stays neutral.
    '--color-success': ['#15803d', '#15803d'],
    '--color-on-success': ['#ffffff', '#ffffff'],
    '--color-success-muted': ['#15803d1f', '#4ade8029'],
    '--color-text-success': done,
    '--color-on-success-muted': done,
    '--color-warning': ['#b45309', '#fbbf24'],
    '--color-on-warning': ['#ffffff', '#0a0a0a'],
    '--color-warning-muted': ['#b453091f', '#fbbf2429'],
    '--color-text-warning': stale,
    '--color-on-warning-muted': stale,
    '--color-error': ['#b91c1c', '#dc2626'],
    '--color-on-error': ['#ffffff', '#ffffff'],
    '--color-error-muted': ['#b91c1c1f', '#f8717129'],
    '--color-text-error': blocked,
    '--color-on-error-muted': blocked,
    '--color-background-error-inverted': ['#b91c1c', '#dc2626'],
    '--color-info': ink,
    '--color-on-info': paper,
    '--color-info-muted': grey100,
    '--color-text-info': ink,
    '--color-on-info-muted': ink,

    // 6px controls, 8px surfaces.
    '--radius-inner': '4px',
    '--radius-element': '6px',
    '--radius-container': '8px',
    '--radius-page': '8px',

    // The keyboard focus ring is ink, sitting close to the control.
    '--focus-outline-color': ink,
    '--focus-outline-offset': '1px',
  },
})
