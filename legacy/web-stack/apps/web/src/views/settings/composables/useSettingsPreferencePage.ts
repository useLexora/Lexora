import type { AppearancePreference, LanguagePreference } from '@haohaoxue/lexora-contracts'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export function useSettingsPreferencePage() {
  const userStore = useUserStore()
  const { t } = useI18n({ useScope: 'global' })
  const errorMessage = shallowRef('')
  const isLoading = shallowRef(false)
  const isSavingLanguage = computed(() => userStore.isSavingLanguage)
  const isSavingAppearance = computed(() => userStore.isSavingAppearance)
  const languagePreference = computed<LanguagePreference>({
    get: () => userStore.preferences.language,
    set: (value) => {
      void saveLanguagePreference(value)
    },
  })
  const appearancePreference = computed<AppearancePreference>({
    get: () => userStore.preferences.appearance,
    set: (value) => {
      void saveAppearancePreference(value)
    },
  })

  async function saveLanguagePreference(value: LanguagePreference) {
    try {
      await userStore.updateLanguagePreference(value)
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.preference.saveLanguageFailed')))
    }
  }

  async function saveAppearancePreference(value: AppearancePreference) {
    try {
      await userStore.updateAppearancePreference(value)
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('settings.preference.saveAppearanceFailed')))
    }
  }

  return {
    appearancePreference,
    errorMessage,
    isLoading,
    isSavingAppearance,
    isSavingLanguage,
    languagePreference,
  }
}
