import { perceivedBrightness } from '@sim/utils/color'

/**
 * True when `color` is dark enough to warrant a light foreground. Non-color
 * values (gradients, `currentColor`, unknown) are treated as not dark.
 * `threshold` is the perceived-brightness cutoff (default 0.5, the conventional
 * midpoint for binary text contrast).
 */
export function isDarkColor(color: string, threshold = 0.5): boolean {
  const brightness = perceivedBrightness(color)
  return brightness !== null && brightness < threshold
}

/**
 * Black or white — whichever reads on top of `color`. Dark colors get white
 * text; light colors (and unparseable values) get black. Uses the 0.5 midpoint
 * ({@link isDarkColor}'s default), the conventional binary text-contrast cutoff.
 */
export function getContrastTextColor(color: string): '#000000' | '#ffffff' {
  return isDarkColor(color) ? '#ffffff' : '#000000'
}
