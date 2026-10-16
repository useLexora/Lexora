import type { ChatModelItem } from '@/apis/chat'
import { createSharedComposable } from '@vueuse/core'
import { shallowRef } from 'vue'
import { getChatModels } from '@/apis/chat'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import { useChatRuntimeConfig } from './useChatRuntimeConfig'

export interface RefreshModelsOptions {
  silent?: boolean
  showSuccessMessage?: boolean
  skipRuntimeConfigReload?: boolean
}

export const useChatModels = createSharedComposable(() => {
  const { loadRuntimeConfig } = useChatRuntimeConfig()
  const modelOptions = shallowRef<ChatModelItem[]>([])
  const isLoadingModels = shallowRef(false)

  async function refreshModels(options: RefreshModelsOptions = {}) {
    const {
      silent = false,
      showSuccessMessage = true,
      skipRuntimeConfigReload = false,
    } = options

    const hasRuntimeConfig = skipRuntimeConfigReload
      ? true
      : await loadRuntimeConfig({ silent })

    if (!hasRuntimeConfig) {
      return
    }

    isLoadingModels.value = true

    try {
      const result = await getChatModels()
      modelOptions.value = result.models

      if (showSuccessMessage) {
        ElMessage.success(result.models.length > 0
          ? translate('chat.model.loaded', { count: result.models.length })
          : translate('chat.model.none'))
      }
    }
    catch (error) {
      modelOptions.value = []

      if (!silent) {
        ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.loadModels')))
      }
    }
    finally {
      isLoadingModels.value = false
    }
  }

  return {
    isLoadingModels,
    modelOptions,
    refreshModels,
  }
})
