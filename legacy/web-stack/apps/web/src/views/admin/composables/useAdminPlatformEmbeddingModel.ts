import type {
  AiDefaultModelPolicyItem,
  AiModelRef,
} from '@/apis/ai'
import { shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getPlatformEmbeddingAiModel,
  updatePlatformEmbeddingAiModel,
} from '@/apis/ai'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

export function useAdminPlatformEmbeddingModel() {
  const { t } = useI18n({ useScope: 'global' })
  const platformModelSettingsVisible = shallowRef(false)
  const platformEmbeddingModelPolicy = shallowRef<AiDefaultModelPolicyItem | null>(null)
  const platformEmbeddingModelRef = shallowRef<AiModelRef | null>(null)
  const isPlatformEmbeddingModelLoading = shallowRef(false)
  const isPlatformEmbeddingModelSaving = shallowRef(false)

  async function openPlatformModelSettings() {
    platformModelSettingsVisible.value = true
    await loadPlatformEmbeddingModel()
  }

  async function loadPlatformEmbeddingModel() {
    if (isPlatformEmbeddingModelLoading.value) {
      return
    }

    isPlatformEmbeddingModelLoading.value = true
    try {
      syncPlatformEmbeddingModel(await getPlatformEmbeddingAiModel())
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('admin.errors.loadEmbeddingModel')))
    }
    finally {
      isPlatformEmbeddingModelLoading.value = false
    }
  }

  async function updatePlatformEmbeddingModel(modelRef: AiModelRef | null) {
    const previousModelRef = platformEmbeddingModelRef.value
    platformEmbeddingModelRef.value = modelRef
    isPlatformEmbeddingModelSaving.value = true

    try {
      const policy = await updatePlatformEmbeddingAiModel({
        modelRef: modelRef
          ? {
              providerId: modelRef.providerId,
              modelId: modelRef.modelId,
            }
          : null,
      })
      syncPlatformEmbeddingModel(policy)
      ElMessage.success(policy.modelRef ? t('admin.platformModel.updated') : t('admin.platformModel.cleared'))
    }
    catch (error) {
      platformEmbeddingModelRef.value = previousModelRef
      ElMessage.error(getRequestErrorDisplayMessage(error, t('admin.errors.updateEmbeddingModel')))
    }
    finally {
      isPlatformEmbeddingModelSaving.value = false
    }
  }

  function syncPlatformEmbeddingModel(policy: AiDefaultModelPolicyItem) {
    platformEmbeddingModelPolicy.value = policy
    platformEmbeddingModelRef.value = policy.modelRef
  }

  return {
    platformModelSettingsVisible,
    platformEmbeddingModelPolicy,
    platformEmbeddingModelRef,
    isPlatformEmbeddingModelLoading,
    isPlatformEmbeddingModelSaving,
    openPlatformModelSettings,
    updatePlatformEmbeddingModel,
  }
}
