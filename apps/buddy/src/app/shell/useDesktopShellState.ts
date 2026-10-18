import type { DesktopAppInfo, LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { ApplicationSettings } from '@/modules/settings'
import { computed, onScopeDispose, readonly, shallowRef } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { loadDesktopAppInfo } from '@/platform/desktop/desktopCapabilities'

export function useDesktopShellState(settings: ApplicationSettings, api: LexoraDesktopApi = requireDesktopApi()) {
  let disposed = false
  onScopeDispose(() => {
    disposed = true
  })
  const appInfo = shallowRef<DesktopAppInfo | null>(null)
  const navigationLayout = computed(() => settings.config.value?.desktop.navigationLayout ?? 'full')
  const appSidebarCollapsed = computed(() => navigationLayout.value !== 'full' || (settings.config.value?.desktop.sidebarCollapsed ?? false))

  async function initialize() {
    const info = await loadDesktopAppInfo(api)
    if (!disposed)
      appInfo.value = info
  }

  async function setAppSidebarCollapsed(value: boolean) {
    if (settings.config.value?.desktop.sidebarCollapsed === value)
      return true
    return settings.updateSettings({ desktop: { sidebarCollapsed: value } })
  }

  return {
    appInfo: readonly(appInfo),
    appSidebarCollapsed,
    navigationLayout,
    platformCapabilities: computed(() => appInfo.value?.capabilities ?? null),
    initialize,
    setAppSidebarCollapsed,
  }
}
