import type { ComponentProps } from 'react'
import { Heading as AstryxHeading } from '@astryxdesign/core/Heading'
import { sizeByLevelStyles } from '@astryxdesign/core/Text/text.stylex'

/**
 * Astryx's Heading with `accessibilityLevel` that browsers honour. Astryx puts
 * `aria-level` on the visual tag (an h4 with aria-level 2), and Chromium keeps
 * reporting the native level, so the page outline was wrong. This renders the
 * semantic tag and keeps the visual level's size through `xstyle`.
 */
export function Heading({ level, accessibilityLevel, xstyle, ...props }: ComponentProps<typeof AstryxHeading>) {
  if (!accessibilityLevel || accessibilityLevel === level || !level) {
    return <AstryxHeading level={level} accessibilityLevel={accessibilityLevel} xstyle={xstyle} {...props} />
  }
  return <AstryxHeading level={accessibilityLevel} xstyle={[sizeByLevelStyles[level], xstyle]} {...props} />
}
