import type { BuddyColorTheme } from './buddyTheme'
import type { ThemeColors, ThemeDescriptor, ThemeDocument, ThemeDocumentInput } from './themeDocument'
import { buddyColorThemes, createBuddyColorVariables } from './buddyTheme'
import { themeDocumentSchema } from './themeDocument'
import { semanticColorTokens } from './themeTokens'

export interface ResolvedTheme {
  descriptor: ThemeDescriptor
  colors: ThemeColors
  variables: Record<string, string>
  document: ThemeDocument
  assets: Record<string, string>
}

export function normalizeThemeColor(value: string): string {
  if (value.startsWith('#'))
    return value.toLowerCase()
  const parts = value.match(/[\d.]+%?/g) ?? []
  const channels = parts.slice(0, 3).map(channel => Math.round(Number.parseFloat(channel)))
  if (parts[3])
    channels.push(Math.round(Number.parseFloat(parts[3]) * (parts[3].endsWith('%') ? 2.55 : 255)))
  return `#${channels.map(channel => Math.min(255, channel).toString(16).padStart(2, '0')).join('')}`
}

export function mixThemeColor(color: string, target: string, amount: number): string {
  return `#${[1, 3, 5].map((offset) => {
    const from = Number.parseInt(color.slice(offset, offset + 2), 16)
    const to = Number.parseInt(target.slice(offset, offset + 2), 16)
    return Math.round(from + (to - from) * amount).toString(16).padStart(2, '0')
  }).join('')}`
}
const alpha = (color: string, amount: number) => `${color.slice(0, 7)}${Math.round(amount * 255).toString(16).padStart(2, '0')}`

export function resolveTheme(descriptor: ThemeDescriptor, input: ThemeDocumentInput, overrides: ThemeDocumentInput['colors'] = {}, assets: Record<string, string> = {}): ResolvedTheme {
  const document = themeDocumentSchema.parse(input)
  const explicit = themeDocumentSchema.parse({ schemaVersion: 1, colors: { ...document.colors, ...overrides } }).colors
  const dark = descriptor.appearance === 'dark'
  const variables = createBuddyColorVariables(buddyColorThemes[descriptor.appearance])
  const defaults = Object.fromEntries(Object.entries(semanticColorTokens).filter(([, variable]) => variables[variable] !== undefined).map(([key, variable]) => [key, normalizeThemeColor(variables[variable]!)])) as ThemeColors
  const base = { ...defaults, ...explicit }
  const accent = base.accent
  const text = explicit['accent-text'] ?? (dark ? mixThemeColor(accent, '#ffffff', 0.5) : mixThemeColor(accent, '#000000', 0.18))
  const tint = dark ? text : accent
  const hover = explicit.hover ?? alpha(tint, dark ? 0.08 : 0.07)
  const selected = explicit.selected ?? alpha(tint, dark ? 0.13 : 0.12)
  const selectedHover = explicit['selected-hover'] ?? alpha(tint, dark ? 0.18 : 0.16)
  const pressed = explicit.pressed ?? alpha(tint, dark ? 0.24 : 0.20)
  const onSurface = explicit['accent-on-surface'] ?? (dark ? mixThemeColor(text, '#ffffff', 0.24) : text)
  const terminal = dark
    ? ['#1e1e2e', '#cdd6f4', '#9399b2', '#6c7086', '#cba6f7', '#89b4fa', '#a6e3a1', '#f9e2af', '#fab387', '#eba0ac', '#89dceb', '#f5e0dc']
    : ['#eff1f5', '#4c4f69', '#7c7f93', '#9ca0b0', '#8839ef', '#1e66f5', '#40a02b', '#df8e1d', '#fe640b', '#e64553', '#04a5e5', '#dc8a78']
  const terminalNames = ['background', 'foreground', 'muted', 'scrollbar', 'mauve', 'blue', 'green', 'yellow', 'peach', 'maroon', 'sky', 'rosewater']
  const colors: ThemeColors = {
    ...base,
    'app-sidebar': explicit['app-sidebar'] ?? base.canvas,
    'workspace-sidebar': explicit['workspace-sidebar'] ?? base.canvas,
    'surface': explicit.surface ?? base.canvas,
    'reading': base.canvas,
    'reading-fg': base.fg,
    'composer': base.surface ?? base.canvas,
    'composer-fg': base.strong,
    'app-sidebar-fg': base.fg,
    'workspace-sidebar-fg': base.fg,
    'hover': hover,
    'selected': selected,
    'selected-hover': selectedHover,
    'pressed': pressed,
    'hover-fg': base.strong,
    'pressed-fg': onSurface,
    'selected-fg': onSurface,
    'nav-hover': hover,
    'nav-selected': selected,
    'nav-selected-hover': selectedHover,
    'nav-pressed': pressed,
    'nav-foreground': explicit['selected-fg'] ?? onSurface,
    'accent-hover': mixThemeColor(accent, '#ffffff', 0.12),
    'accent-pressed': mixThemeColor(accent, '#000000', 0.16),
    'accent-text': text,
    'focus': text,
    'accent-subtle': hover,
    'accent-surface': selected,
    'accent-surface-hover': selectedHover,
    'accent-surface-pressed': pressed,
    'accent-border': alpha(tint, 0.38),
    'accent-border-hover': alpha(tint, 0.54),
    'accent-on-surface': onSurface,
    'text-selection': alpha(text, 0.25),
    'text-selection-inactive': alpha(text, 0.15),
    'text-selection-match': alpha(text, 0.12),
    'user-message': selected,
    'link': text,
    'quote': base.muted,
    'quote-border': alpha(tint, 0.38),
    'inline-code': base.subtle,
    'inline-code-fg': text,
    'code': base.raised,
    'code-fg': base.fg,
    'table-header': base.subtle,
    'table-border': base.border,
    'diff-added': alpha(base.success, 0.14),
    'diff-removed': alpha(base.danger, 0.14),
    'editor': base.canvas,
    'editor-fg': base.fg,
    'editor-line': hover,
    'editor-gutter': base.muted,
    'editor-cursor': text,
    'syntax-comment': base.muted,
    'syntax-keyword': base['data-violet'],
    'syntax-string': base.success,
    'syntax-number': base.warning,
    'syntax-function': base['data-blue'],
    'syntax-type': base['data-cyan'],
    'syntax-variable': base.fg,
    'syntax-operator': text,
    ...Object.fromEntries(terminalNames.map((name, index) => [`terminal-${name}`, terminal[index]!])),
    ...explicit,
  }
  for (const [name, value] of Object.entries(colors)) {
    const variable = semanticColorTokens[name as keyof typeof semanticColorTokens] ?? `--buddy-${name}`
    variables[variable] = value
  }
  variables['--buddy-text-muted'] = colors.muted
  variables['--buddy-terminal-selection'] = colors['text-selection']
  for (const [name, shadows] of Object.entries(document.shadows))
    variables[`--buddy-shadow-${name}`] = shadows.map(shadow => `${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.spread}px ${shadow.color}`).join(', ') || 'none'
  return { descriptor, colors, variables, document, assets }
}

export function fallbackTheme(appearance: 'light' | 'dark'): ResolvedTheme {
  const variables = createBuddyColorVariables(buddyColorThemes[appearance])
  const colors = Object.fromEntries(Object.entries(semanticColorTokens).filter(([, variable]) => variables[variable] !== undefined).map(([key, variable]) => [key, normalizeThemeColor(variables[variable]!)]))
  return resolveTheme({ id: `lexora.fallback.${appearance}`, appearance, label: 'Lexora', source: 'fallback', extensionId: null, packageName: 'Lexora', swatch: colors.accent! }, { schemaVersion: 1, colors })
}

export function projectBuddyTheme(resolved: ResolvedTheme): BuddyColorTheme {
  const c = resolved.colors
  const theme = structuredClone(buddyColorThemes[resolved.descriptor.appearance])
  theme.surface = { canvas: c.canvas, raised: c.raised, muted: c.subtle, userMessage: c['user-message'] }
  theme.state = { hover: c.hover, pressed: c.pressed, selected: c.selected, selectedHover: c['selected-hover'] }
  theme.selection = { background: c['text-selection'], inactive: c['text-selection-inactive'], match: c['text-selection-match'] }
  theme.border = { subtle: c.border, strong: c['border-strong'] }
  theme.text = { strong: c.strong, primary: c.fg, secondary: c.muted, disabled: c.disabled, onAccent: c['on-accent'] }
  theme.accent = { solid: c.accent, solidHover: c['accent-hover'], solidPressed: c['accent-pressed'], text: c['accent-text'], focus: c.focus, surfaceSubtle: c['accent-subtle'], surface: c['accent-surface'], surfaceHover: c['accent-surface-hover'], surfacePressed: c['accent-surface-pressed'], border: c['accent-border'], borderHover: c['accent-border-hover'], onOverlay: c['accent-text'], onSurface: c['accent-on-surface'] }
  for (const status of ['success', 'warning', 'danger'] as const) {
    const solid = c[`${status}-solid`]
    theme.status[status] = { solid, solidHover: mixThemeColor(solid, '#ffffff', 0.10), solidPressed: mixThemeColor(solid, '#000000', 0.16), text: c[status], surface: c[`${status}-surface`], surfaceHover: c[`${status}-surface-hover`], border: c[`${status}-border`] }
  }
  theme.avatar = { background: c.avatar, foreground: c['avatar-foreground'] }
  for (const name of Object.keys(theme.shadow) as Array<keyof BuddyColorTheme['shadow']>)
    theme.shadow[name] = resolved.variables[`--buddy-shadow-${name}`]!
  return theme
}
