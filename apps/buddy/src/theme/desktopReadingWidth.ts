import type { DesktopChatReadingWidth } from '@buddy-electron/shared/desktopApi'
import { DEFAULT_DESKTOP_CHAT_PREFERENCES } from '@buddy-electron/shared/desktopApi'
import { watch } from 'vue'

const readingWidths: Record<DesktopChatReadingWidth, string> = {
  narrow: '42rem',
  standard: '50rem',
  wide: '64rem',
}

export function useDesktopReadingWidth(preference: () => DesktopChatReadingWidth | undefined) {
  watch(preference, (value = DEFAULT_DESKTOP_CHAT_PREFERENCES.readingWidth) => {
    document.documentElement.style.setProperty('--buddy-chat-reading-width', readingWidths[value])
  }, { immediate: true })
}
