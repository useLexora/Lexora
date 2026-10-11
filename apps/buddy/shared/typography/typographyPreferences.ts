import { z } from 'zod'
import { themeFonts } from '../theme/themeTokens'

export const typographyFontSchema = z.string().trim().max(100).refine(value => !/\p{Cc}/u.test(value))
export const typographyPreferencesSchema = z.object({
  uiFont: typographyFontSchema,
  bodyFont: typographyFontSchema,
  codeFont: typographyFontSchema,
  bodySize: z.number().int().min(12).max(20),
}).strict()

export type TypographyPreferences = z.infer<typeof typographyPreferencesSchema>

export const DEFAULT_TYPOGRAPHY: Readonly<TypographyPreferences> = {
  uiFont: '',
  bodyFont: '',
  codeFont: '',
  bodySize: 14,
}

export function resolveTypography(preferences: Readonly<TypographyPreferences>) {
  const font = (family: string, fallback: string) => family
    ? `"${family.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}", ${fallback}`
    : fallback
  return {
    ui: font(preferences.uiFont, themeFonts.ui),
    body: font(preferences.bodyFont, themeFonts.ui),
    mono: font(preferences.codeFont, themeFonts.mono),
    bodySize: `${preferences.bodySize}px`,
    bodyLineHeight: `${Math.round(preferences.bodySize * 12 / 7)}px`,
  }
}
