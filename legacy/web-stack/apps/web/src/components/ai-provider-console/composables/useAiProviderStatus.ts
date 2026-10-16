import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import type { AiProviderConsoleMode } from '../typing'
import type { AiProvider } from '@/apis/ai'
import { shallowRef, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import { updatePlatformAiProvider, updateUserAiProvider } from '@/apis/ai'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

/**
 * AI 服务商状态参数。
 */
export interface UseAiProviderStatusOptions {
  /** 控制台模式 */
  mode: MaybeRefOrGetter<AiProviderConsoleMode>
  /** 当前服务商 */
  selectedProvider: ComputedRef<AiProvider | null>
  /** 当前已启用模型数 */
  enabledModelCount: ComputedRef<number>
  /** 更新服务商缓存 */
  patchProvider: (provider: AiProvider) => void
}

export function useAiProviderStatus(options: UseAiProviderStatusOptions) {
  const { t } = useI18n({ useScope: 'global' })
  const isUpdatingProviderStatus = shallowRef(false)

  async function updateProviderEnabled(value: string | number | boolean) {
    const provider = options.selectedProvider.value
    const enabled = Boolean(value)
    if (!provider || provider.enabled === enabled) {
      return
    }

    if (enabled && options.enabledModelCount.value === 0) {
      ElMessage.warning(t('aiProvider.messages.requireEnabledModel'))
      return
    }

    isUpdatingProviderStatus.value = true

    try {
      const nextProvider = currentMode() === 'platform'
        ? await updatePlatformAiProvider(provider.providerId, { enabled })
        : await updateUserAiProvider(provider.providerId, { enabled })

      options.patchProvider(nextProvider)
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.updateProviderStatus')))
    }
    finally {
      isUpdatingProviderStatus.value = false
    }
  }

  function currentMode() {
    return toValue(options.mode)
  }

  return {
    isUpdatingProviderStatus,
    updateProviderEnabled,
  }
}
