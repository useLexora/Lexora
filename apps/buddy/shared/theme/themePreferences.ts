import { z } from 'zod'

export const DESKTOP_ACCENT_COLORS = ['default', 'green', 'violet', 'rose', 'amber'] as const

export type DesktopAccentColor = typeof DESKTOP_ACCENT_COLORS[number]
export type DesktopThemePreference = 'system' | 'light' | 'dark'

export const themeIdSchema = z.string().max(180).regex(/^[a-z][a-z0-9.-]+$/)
export const themePreferenceSchema = z.object({
  id: themeIdSchema,
}).strict()
export const legacyThemePreferenceSchema = z.object({
  mode: z.enum(['system', 'light', 'dark']),
  light: themeIdSchema,
  dark: themeIdSchema,
}).strict()
export type ThemePreference = z.infer<typeof themePreferenceSchema>
export const DEFAULT_THEME_PREFERENCE: ThemePreference = {
  id: 'system',
}

export function migrateThemePreference(preference: ThemePreference | z.infer<typeof legacyThemePreferenceSchema> | DesktopThemePreference, accent: DesktopAccentColor): ThemePreference {
  if (typeof preference !== 'string' && 'id' in preference)
    return preference
  const mode = typeof preference === 'string' ? preference : preference.mode
  if (mode === 'system')
    return { ...DEFAULT_THEME_PREFERENCE }
  if (typeof preference !== 'string')
    return { id: preference[mode] }
  const name = accent === 'default' ? 'classic' : accent
  return { id: `lexora.themes.${name}-${mode}` }
}
