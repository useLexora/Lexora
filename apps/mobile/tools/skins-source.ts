import classicDark from '../../buddy/extensions/bundled/lexora.themes/themes/classic-dark.json'
import classicLight from '../../buddy/extensions/bundled/lexora.themes/themes/classic-light.json'
import { resolveTheme } from '../../buddy/shared/theme/resolveTheme'
import { themeDocumentSchema } from '../../buddy/shared/theme/themeDocument'
import { themeFonts } from '../../buddy/shared/theme/themeTokens'
import { markdownThemeVariables } from '../../buddy/src/theme/markdownTheme'

export function resolveSkinPalette(appearance: 'light' | 'dark', colors: Record<string, string>) {
  const classic = appearance === 'dark' ? classicDark : classicLight
  const document = themeDocumentSchema.parse({ ...classic, colors: { ...classic.colors, ...colors } })
  const theme = resolveTheme({ id: `mobile-${appearance}`, label: 'Lexora', appearance, source: 'fallback', extensionId: null, packageName: '', swatch: '' }, document)
  return {
    colors: theme.colors,
    variables: {
      ...theme.variables,
      ...markdownThemeVariables(theme.colors),
      '--buddy-font-ui': themeFonts.ui,
      '--buddy-font-body': themeFonts.ui,
      '--buddy-font-mono': themeFonts.mono,
    },
  }
}
