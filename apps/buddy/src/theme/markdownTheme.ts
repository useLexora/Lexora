import type { ThemeColors } from '@buddy-shared/theme/themeDocument'

function hsl(color: string, background: string): string {
  const alpha = color.length === 9 ? Number.parseInt(color.slice(7), 16) / 255 : 1
  const [r, g, b] = [1, 3, 5].map(offset => (Number.parseInt(color.slice(offset, offset + 2), 16) * alpha + Number.parseInt(background.slice(offset, offset + 2), 16) * (1 - alpha)) / 255) as [number, number, number]
  const high = Math.max(r, g, b)
  const low = Math.min(r, g, b)
  const d = high - low
  const lightness = (high + low) / 2
  const hue = !d ? 0 : high === r ? ((g - b) / d + 6) % 6 : high === g ? (b - r) / d + 2 : (r - g) / d + 4
  const saturation = d ? d / (1 - Math.abs(2 * lightness - 1)) : 0
  return `${hue * 60} ${saturation * 100}% ${lightness * 100}%`
}

export function markdownThemeVariables(c: ThemeColors): Record<string, string> {
  const palette = { 'background': c.reading, 'foreground': c['reading-fg'], 'muted': c.subtle, 'muted-foreground': c.muted, 'secondary': c.hover, 'secondary-foreground': c.fg, 'accent': c.selected, 'accent-foreground': c['selected-fg'], 'primary': c.accent, 'primary-foreground': c['on-accent'], 'border': c.border, 'ring': c.focus, 'popover': c.raised, 'popover-foreground': c.fg, 'info': c['accent-text'], 'success': c.success, 'warning': c.warning, 'destructive': c.danger, 'highlight': c['text-selection'], 'highlight-foreground': c.fg }
  return {
    ...Object.fromEntries(Object.entries(palette).map(([name, value]) => [`--ms-${name}`, hsl(value, c.reading)])),
    '--link-color': c.link,
    '--blockquote-fg': c.quote,
    '--blockquote-border': c['quote-border'],
    '--inline-code-bg': c['inline-code'],
    '--inline-code-fg': c['inline-code-fg'],
    '--code-bg': c.code,
    '--code-fg': c['code-fg'],
    '--code-border': c.border,
    '--code-header-bg': c.subtle,
    '--code-selection-bg': c['text-selection'],
    '--markstream-code-fallback-bg': c.code,
    '--markstream-code-fallback-fg': c['code-fg'],
    '--markstream-code-fallback-selection-bg': c['text-selection'],
    '--code-action-fg': c.muted,
    '--code-action-hover-bg': c.hover,
    '--code-action-hover-fg': c['hover-fg'],
    '--code-action-active-bg': c.selected,
    '--code-action-active-fg': c['selected-fg'],
    '--table-header-bg': c['table-header'],
    '--table-border': c['table-border'],
    '--diff-added-bg': c['diff-added'],
    '--diff-removed-bg': c['diff-removed'],
    '--diff-added-fg': c.success,
    '--diff-removed-fg': c.danger,
  }
}
