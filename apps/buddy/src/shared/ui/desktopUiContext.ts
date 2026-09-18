import type { DesktopChatPreferences } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { createInjectionState } from '@vueuse/core'

interface DesktopUiContext {
  language: Readonly<Ref<BuddyLocale>>
  isDark: Readonly<Ref<boolean>>
  chat: Readonly<Ref<Readonly<DesktopChatPreferences>>>
  appSidebarCollapsed: Readonly<Ref<boolean>>
}

const [useProvideDesktopUi, injectDesktopUi] = createInjectionState(
  (context: DesktopUiContext) => context,
)

export { useProvideDesktopUi }

export function useDesktopUi(): DesktopUiContext {
  const context = injectDesktopUi()
  if (!context)
    throw new Error('Desktop UI context is unavailable')
  return context
}
