import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import type { AiProviderConsoleMode } from '../typing'
import type { AiProvider } from '@/apis/ai'
import { AI_PROVIDER_AUTH_MODE } from '@haohaoxue/lexora-contracts/ai/constants'
import { computed, reactive, shallowRef, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getPlatformAiProviderCredential,
  getUserAiProviderCredential,
  updatePlatformAiProvider,
  updateUserAiProvider,
} from '@/apis/ai'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { isValidProviderEndpointUrl } from '../utils/providerDisplay'

/**
 * 模型服务凭证参数。
 */
export interface UseAiProviderCredentialsOptions {
  /** 控制台模式 */
  mode: MaybeRefOrGetter<AiProviderConsoleMode>
  /** 当前服务商 */
  selectedProvider: ComputedRef<AiProvider | null>
  /** 更新服务商缓存 */
  patchProvider: (provider: AiProvider) => void
}

export function useAiProviderCredentials(options: UseAiProviderCredentialsOptions) {
  const { t } = useI18n({ useScope: 'global' })
  const isSavingEndpoint = shallowRef(false)
  const isSavingApiKey = shallowRef(false)
  const isLoadingApiKey = shallowRef(false)
  let apiKeyRequestId = 0

  const endpointForm = reactive({
    endpoint: '',
  })

  const apiKeyForm = reactive({
    apiKey: '',
  })

  const canEditEndpoint = computed(() => options.selectedProvider.value?.endpointEditable ?? false)
  const requiresApiKey = computed(() => Boolean(
    options.selectedProvider.value
    && options.selectedProvider.value.authMode !== AI_PROVIDER_AUTH_MODE.NONE,
  ))

  function syncCredentialForms() {
    apiKeyRequestId += 1
    isLoadingApiKey.value = false
    endpointForm.endpoint = options.selectedProvider.value?.endpoint ?? ''
    apiKeyForm.apiKey = ''
  }

  async function loadApiKeyForSelectedProvider() {
    const provider = options.selectedProvider.value
    if (!provider || !requiresApiKey.value) {
      apiKeyRequestId += 1
      isLoadingApiKey.value = false
      apiKeyForm.apiKey = ''
      return
    }

    const requestId = apiKeyRequestId + 1
    apiKeyRequestId = requestId
    isLoadingApiKey.value = true

    try {
      const credential = currentMode() === 'platform'
        ? await getPlatformAiProviderCredential(provider.providerId)
        : await getUserAiProviderCredential(provider.providerId)

      if (apiKeyRequestId === requestId && options.selectedProvider.value?.providerId === provider.providerId) {
        apiKeyForm.apiKey = credential.apiKey ?? ''
      }
    }
    catch (error) {
      if (apiKeyRequestId === requestId) {
        apiKeyForm.apiKey = ''
        ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.loadApiKey')))
      }
    }
    finally {
      if (apiKeyRequestId === requestId) {
        isLoadingApiKey.value = false
      }
    }
  }

  async function saveApiKey() {
    const provider = options.selectedProvider.value
    if (!provider) {
      return
    }

    isSavingApiKey.value = true
    const apiKey = apiKeyForm.apiKey.trim()

    try {
      const nextProvider = currentMode() === 'platform'
        ? await updatePlatformAiProvider(provider.providerId, apiKey ? { apiKey } : { clearApiKey: true })
        : await updateUserAiProvider(provider.providerId, apiKey ? { apiKey } : { clearApiKey: true })

      options.patchProvider(nextProvider)
      apiKeyForm.apiKey = apiKey
      ElMessage.success(apiKey ? t('aiProvider.messages.apiKeySaved') : t('aiProvider.messages.apiKeyCleared'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.saveApiKey')))
    }
    finally {
      isSavingApiKey.value = false
    }
  }

  async function saveEndpoint() {
    const provider = options.selectedProvider.value
    if (!provider || !canEditEndpoint.value) {
      return true
    }

    const endpoint = endpointForm.endpoint.trim()
    if (!endpoint) {
      ElMessage.warning(t('aiProvider.messages.endpointRequired'))
      return false
    }

    if (!isValidProviderEndpointUrl(endpoint)) {
      ElMessage.warning(t('aiProvider.messages.endpointInvalid'))
      return false
    }

    const currentEndpoint = provider.endpoint ?? ''
    if (currentEndpoint === endpoint) {
      return true
    }

    isSavingEndpoint.value = true

    try {
      const nextProvider = currentMode() === 'platform'
        ? await updatePlatformAiProvider(provider.providerId, { endpoint })
        : await updateUserAiProvider(provider.providerId, { endpoint })

      options.patchProvider(nextProvider)
      endpointForm.endpoint = nextProvider.endpoint ?? endpoint
      ElMessage.success(t('aiProvider.messages.endpointSaved'))
      return true
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.saveEndpoint')))
      return false
    }
    finally {
      isSavingEndpoint.value = false
    }
  }

  function currentMode() {
    return toValue(options.mode)
  }

  return {
    isSavingEndpoint,
    isSavingApiKey,
    isLoadingApiKey,
    endpointForm,
    apiKeyForm,
    canEditEndpoint,
    requiresApiKey,
    syncCredentialForms,
    loadApiKeyForSelectedProvider,
    saveApiKey,
    saveEndpoint,
  }
}
