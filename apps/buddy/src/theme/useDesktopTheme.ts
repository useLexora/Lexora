import { projectBuddyTheme } from '@buddy-shared/theme/resolveTheme'
import { createExtensionThemeColors } from '@buddy-shared/theme/themeTokens'
import { createInjectionState } from '@vueuse/core'
import { computed } from 'vue'
import { desktopThemeSnapshot } from './desktopThemeState'
import { createBuddyNaiveThemeOverrides } from './naiveTheme'

const [useProvideDesktopTheme, injectDesktopTheme] = createInjectionState(() => {
  const snapshot = desktopThemeSnapshot
  const resolved = computed(() => snapshot.value.active)
  const isDark = computed(() => resolved.value.descriptor.appearance === 'dark')
  const theme = computed(() => projectBuddyTheme(resolved.value))
  const variables = computed(() => resolved.value.variables)
  const overrides = computed(() => createBuddyNaiveThemeOverrides(theme.value))
  const extensionColors = computed(() => createExtensionThemeColors(variables.value))
  const revision = computed(() => snapshot.value.revision)
  return { isDark, theme, resolved, snapshot, revision, overrides, extensionColors }
})

export { useProvideDesktopTheme }

export function useDesktopTheme() {
  const theme = injectDesktopTheme()
  if (!theme)
    throw new Error('Desktop theme is unavailable')
  return theme
}
