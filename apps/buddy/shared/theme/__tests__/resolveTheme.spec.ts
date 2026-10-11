import type { ThemeColor } from '../../../service/resources/skills/plugin-creator/references/api'
import type { ThemeColorName } from '../themeDocument'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { fallbackTheme, resolveTheme } from '../resolveTheme'
import { themeColorNames, themeColorSchema } from '../themeDocument'

expectTypeOf<ThemeColor>().toEqualTypeOf<ThemeColorName>()

describe('resolved theme colors', () => {
  it.each(['light', 'dark'] as const)('derives complete surface pairs from merged %s colors', (appearance) => {
    const descriptor = fallbackTheme(appearance).descriptor
    const document = {
      schemaVersion: 1 as const,
      colors: { 'accent': '#207cba', 'canvas': '#242031', 'code': '#302940', 'reading-fg': '#eeeaff', 'data-blue': '#99bbe8' },
    }
    const original = resolveTheme(descriptor, document)
    const theme = resolveTheme(descriptor, document, { 'accent': '#96304d', 'canvas': '#282034', 'reading-fg': '#f9f0ff' })
    expect(theme.colors).toMatchObject({
      'surface': '#282034',
      'composer': '#282034',
      'reading-fg': '#f9f0ff',
      'code': '#302940',
      'code-fg': '#f9f0ff',
      'editor': '#302940',
      'editor-fg': '#f9f0ff',
      'syntax-variable': '#f9f0ff',
      'terminal-background': '#302940',
      'terminal-foreground': '#f9f0ff',
      'terminal-blue': '#99bbe8',
    })
    expect(theme.colors.selected).not.toBe(original.colors.selected)
    expect(theme.colors['accent-hover']).not.toBe(original.colors['accent-hover'])
    expect(theme.descriptor).toMatchObject({ swatch: '#96304d', preview: { accent: '#96304d', canvas: '#282034', surface: '#282034', fg: theme.colors.fg } })
    for (const name of themeColorNames)
      expect(themeColorSchema.safeParse(theme.colors[name]).success, name).toBe(true)
  })

  it('preserves explicit role colors when their base colors change', () => {
    const theme = resolveTheme(fallbackTheme('light').descriptor, {
      schemaVersion: 1,
      colors: { 'composer': '#fffaf2', 'code-fg': '#e9f2df', 'terminal-background': '#292d26', 'editor': '#2c3028', 'canvas-grid': '#44554444', 'hover': '#12345678' },
    }, { 'canvas': '#f7f9f2', 'code': '#35392f', 'reading': '#fafafa', 'reading-fg': '#24301b', 'terminal-background': '#21251c' })
    expect(theme.colors).toMatchObject({
      'composer': '#fffaf2',
      'code-fg': '#e9f2df',
      'editor': '#2c3028',
      'terminal-background': '#21251c',
      'terminal-foreground': '#e9f2df',
      'canvas-grid': '#44554444',
      'hover': '#12345678',
      'nav-hover': '#12345678',
      'reading': '#fafafa',
      'canvas': '#f7f9f2',
    })
  })
})
