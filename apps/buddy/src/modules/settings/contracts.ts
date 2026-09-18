import type { LexoraConfig, LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import type { ShortcutEntry } from '@buddy-shared/shortcuts/keybinding'
import type { DeepReadonly, Ref } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'

export interface ApplicationSettings {
  config: Readonly<Ref<DeepReadonly<LexoraConfig> | null>>
  language: Readonly<Ref<BuddyLocale>>
  settingsError: Readonly<Ref<string | null>>
  updateSettings: (patch: LexoraConfigPatch) => Promise<boolean>
}

export interface ShortcutSettings {
  entries: Readonly<Ref<readonly ShortcutEntry[]>>
  bindings: Readonly<Ref<Readonly<Record<string, readonly string[]>>>>
  platform: Readonly<Ref<string>>
  set: (id: string, binding: string | null) => Promise<boolean>
  reset: () => Promise<boolean>
}
