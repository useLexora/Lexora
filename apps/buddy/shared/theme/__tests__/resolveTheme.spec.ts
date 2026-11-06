import type { ThemeDocument as SdkThemeDocument, ThemeColor, WorkbenchRegion } from '../../../service/resources/skills/plugin-creator/references/api'
import type { WorkbenchRegion as HostWorkbenchRegion } from '../../workbench/workbenchRegions'
import type { ThemeColorName, ThemeDocumentInput } from '../themeDocument'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { fallbackTheme, resolveTheme } from '../resolveTheme'
import { themeColorNames, themeColorSchema, themeDocumentSchema } from '../themeDocument'
import { createExtensionThemeColors, createUnoTheme, themeRadiusNames } from '../themeTokens'

expectTypeOf<ThemeColor>().toEqualTypeOf<ThemeColorName>()
expectTypeOf<WorkbenchRegion>().toEqualTypeOf<HostWorkbenchRegion>()
expectTypeOf<SdkThemeDocument['shape']>().toEqualTypeOf<ThemeDocumentInput['shape']>()
expectTypeOf<SdkThemeDocument['motion']>().toEqualTypeOf<ThemeDocumentInput['motion']>()

describe('theme shape and state motion', () => {
  it('keeps defaults when fields are omitted and projects explicit zero values', () => {
    const base = fallbackTheme('light')
    expect(resolveTheme(base.descriptor, { ...base.document, shape: {}, motion: {} }).variables).toEqual(base.variables)
    const theme = resolveTheme(base.descriptor, { schemaVersion: 1, shape: { radius: { 'micro': 0, 'icon': 24, 'control': 8.5, 'menu': 12, 'menu-item': 0 } }, motion: { 'state-duration': 0 } })
    expect(theme.variables).toMatchObject({
      '--buddy-radius-micro': '0px',
      '--buddy-icon-button-radius': '24px',
      '--buddy-composer-control-radius': '8.5px',
      '--buddy-menu-radius': '12px',
      '--buddy-menu-item-radius': '0px',
      '--buddy-theme-motion-state-duration': '0ms',
    })
    expect(createExtensionThemeColors(theme.variables)).toMatchObject({
      'radius-micro': '0px',
      'radius-icon': '24px',
      'radius-control': '8.5px',
      'radius-menu': '12px',
      'radius-menu-item': '0px',
      'theme-motion-state-duration': '0ms',
    })
  })

  it('projects complete plugin defaults and follows the micro radius for an unspecified icon radius', () => {
    const base = fallbackTheme('dark')
    expect(createExtensionThemeColors(base.variables)).toMatchObject({
      'radius-micro': '6px',
      'radius-icon': '6px',
      'radius-control': '8px',
      'radius-menu': '6px',
      'radius-menu-item': '3px',
      'theme-motion-state-duration': '100ms',
    })
    const theme = resolveTheme(base.descriptor, { schemaVersion: 1, shape: { radius: { micro: 2 } }, motion: { 'state-duration': 400 } })
    expect(createExtensionThemeColors(theme.variables)).toMatchObject({ 'radius-icon': '2px', 'theme-motion-state-duration': '400ms' })
    expect(createUnoTheme('buddy').borderRadius).toMatchObject({ icon: 'var(--buddy-icon-button-radius)', control: 'var(--buddy-composer-control-radius)' })
    expect(createUnoTheme('lexora').borderRadius).toMatchObject({ 'icon': 'var(--lexora-radius-icon)', 'menu-item': 'var(--lexora-radius-menu-item)' })
  })

  it.each(themeRadiusNames)('validates the %s radius as a bounded number', (name) => {
    for (const value of [-1, 25, Number.NaN, Number.POSITIVE_INFINITY, '6px'])
      expect(themeDocumentSchema.safeParse({ schemaVersion: 1, shape: { radius: { [name]: value } } }).success).toBe(false)
  })

  it.each([-1, 401, Number.NaN, Number.POSITIVE_INFINITY, '100ms'])('rejects invalid state duration %s', (value) => {
    expect(themeDocumentSchema.safeParse({ schemaVersion: 1, motion: { 'state-duration': value } }).success).toBe(false)
  })

  it.each([
    { shape: { radius: { arbitrary: 4 } } },
    { shape: { css: 'border-radius:4px' } },
    { motion: { duration: 100 } },
    { layout: { 'reading-width': 900 } },
  ])('rejects unsupported theme properties: %j', (fields) => {
    expect(themeDocumentSchema.safeParse({ schemaVersion: 1, ...fields }).success).toBe(false)
  })
})

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
