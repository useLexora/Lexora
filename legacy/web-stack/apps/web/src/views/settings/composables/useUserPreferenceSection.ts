import type { AppearancePreference, LanguagePreference } from '@haohaoxue/lexora-contracts'
import {
  APPEARANCE_PREFERENCE,
  APPEARANCE_PREFERENCE_VALUES,
  LANGUAGE_PREFERENCE,
  LANGUAGE_PREFERENCE_VALUES,
} from '@haohaoxue/lexora-contracts/user/constants'
import { useI18n } from 'vue-i18n'

const languagePreferenceLabelKey = {
  [LANGUAGE_PREFERENCE.AUTO]: 'settings.preference.language.auto',
  [LANGUAGE_PREFERENCE.ZH_CN]: 'settings.preference.language.zhCN',
  [LANGUAGE_PREFERENCE.EN_US]: 'settings.preference.language.enUS',
} as const

const appearancePreferenceLabelKey = {
  [APPEARANCE_PREFERENCE.AUTO]: 'settings.preference.appearance.auto',
  [APPEARANCE_PREFERENCE.LIGHT]: 'settings.preference.appearance.light',
  [APPEARANCE_PREFERENCE.DARK]: 'settings.preference.appearance.dark',
} as const

export function useUserPreferenceSection() {
  const { t } = useI18n({ useScope: 'global' })

  return {
    appearanceOptions: APPEARANCE_PREFERENCE_VALUES,
    formatAppearancePreference: (value: AppearancePreference) => t(appearancePreferenceLabelKey[value]),
    formatLanguagePreference: (value: LanguagePreference) => t(languagePreferenceLabelKey[value]),
    languageOptions: LANGUAGE_PREFERENCE_VALUES,
  }
}
