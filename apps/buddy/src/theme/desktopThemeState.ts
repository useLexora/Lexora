import type { ThemeSnapshot } from '@buddy-shared/theme/themeApi'
import { fallbackTheme } from '@buddy-shared/theme/resolveTheme'
import { DEFAULT_THEME_PREFERENCE } from '@buddy-shared/theme/themePreferences'
import { shallowReadonly, shallowRef } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

const current = shallowRef<ThemeSnapshot>({ revision: -1, preference: DEFAULT_THEME_PREFERENCE, active: fallbackTheme('light'), themes: [], unavailable: null, preview: false })
export const desktopThemeSnapshot = shallowReadonly(current)

export function initializeDesktopTheme(): () => void {
  const api = requireDesktopApi().themes
  const apply = (snapshot: ThemeSnapshot) => {
    if (snapshot.revision < current.value.revision)
      return
    const root = document.documentElement
    for (const name of Object.keys(current.value.active.variables)) {
      if (!(name in snapshot.active.variables))
        root.style.removeProperty(name)
    }
    for (const [name, value] of Object.entries(snapshot.active.variables))
      root.style.setProperty(name, value)
    root.style.colorScheme = snapshot.active.descriptor.appearance
    root.style.backgroundColor = snapshot.active.colors.canvas
    root.dataset.buddyTheme = snapshot.active.descriptor.appearance
    root.dataset.buddyThemeId = snapshot.active.descriptor.id
    current.value = snapshot
  }
  apply(api.initial)
  const stop = api.onDidChange(apply)
  void api.request({ action: 'active' }).then(value => apply(value as ThemeSnapshot))
  return stop
}
