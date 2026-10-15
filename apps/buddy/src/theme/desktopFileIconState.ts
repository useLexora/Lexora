import type { FileIconThemeSnapshot } from '@buddy-shared/icons/fileIconTheme'
import { BUILTIN_FILE_ICON_THEME } from '@buddy-shared/icons/fileIconTheme'
import { shallowReadonly, shallowRef } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

const current = shallowRef<FileIconThemeSnapshot>({ revision: -1, preference: { id: BUILTIN_FILE_ICON_THEME }, themes: [], active: null, unavailable: null })
export const desktopFileIconSnapshot = shallowReadonly(current)

export function initializeDesktopFileIcons(): () => void {
  const api = requireDesktopApi().fileIcons
  const apply = (snapshot: FileIconThemeSnapshot) => {
    if (snapshot.revision >= current.value.revision)
      current.value = snapshot
  }
  apply(api.initial)
  const stop = api.onDidChange(apply)
  void api.request({ action: 'active' }).then(apply).catch(() => {})
  return stop
}
