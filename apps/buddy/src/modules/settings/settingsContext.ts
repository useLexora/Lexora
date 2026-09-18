import type { DesktopAppInfo, DesktopBrowserApi } from '@buddy-electron/shared/desktopApi'
import type { BuddyCapabilities } from '@buddy-shared/platform'
import type { Ref } from 'vue'
import type { ApplicationSettings, ShortcutSettings } from './contracts'
import type { DesktopDataSettingsCapability } from './state/desktopDataSettingsCapability'
import type { McpSettingsCapability } from './state/useMcpSettingsCapability'
import type { WebSettingsCapability } from './state/useWebSettingsCapability'
import type { ModelProvidersStore } from '@/modules/models'
import { createInjectionState } from '@vueuse/core'

export interface SettingsContext {
  shortcuts: ShortcutSettings
  browser: Pick<DesktopBrowserApi, 'clearData' | 'getDataSummary'>
  appInfo: Readonly<Ref<DesktopAppInfo | null>>
  applicationSettings: ApplicationSettings
  dataSettings: DesktopDataSettingsCapability
  platformCapabilities: Readonly<Ref<BuddyCapabilities | null>>
  providerSettings: ModelProvidersStore
  ready: Promise<void>
  openTask: (conversationId: string) => Promise<void>
  webSettings: WebSettingsCapability
  mcpSettings: McpSettingsCapability
}

const [useProvideSettingsContext, injectSettingsContext] = createInjectionState(
  (context: SettingsContext) => context,
)

export { useProvideSettingsContext }

export function useSettingsContext(): SettingsContext {
  const context = injectSettingsContext()
  if (!context)
    throw new Error('Settings context is unavailable')
  return context
}
