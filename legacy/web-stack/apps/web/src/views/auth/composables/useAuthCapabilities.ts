import type { AuthCapabilities } from '@/apis/capabilities'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { getAuthCapabilities } from '@/apis/capabilities'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export function useAuthCapabilities() {
  const { t } = useI18n({ useScope: 'global' })
  const authCapabilities = shallowRef<AuthCapabilities | null>(null)
  const loadErrorMessage = shallowRef('')
  const isLoadingCapabilities = shallowRef(true)
  const passwordRegistrationEnabled = computed(() => authCapabilities.value?.passwordRegistrationEnabled ?? false)
  const passwordRegistrationInviteCodeRequired = computed(() =>
    authCapabilities.value?.passwordRegistrationInviteCodeRequired ?? false,
  )

  async function loadCapabilities() {
    isLoadingCapabilities.value = true
    loadErrorMessage.value = ''

    try {
      authCapabilities.value = await getAuthCapabilities()
    }
    catch (error) {
      loadErrorMessage.value = getRequestErrorDisplayMessage(error, t('auth.capabilities.loadFailed'))
    }
    finally {
      isLoadingCapabilities.value = false
    }
  }

  return {
    authCapabilities,
    isLoadingCapabilities,
    loadCapabilities,
    loadErrorMessage,
    passwordRegistrationInviteCodeRequired,
    passwordRegistrationEnabled,
  }
}
