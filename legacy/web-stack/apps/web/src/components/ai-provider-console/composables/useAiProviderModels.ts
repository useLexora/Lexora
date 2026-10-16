import type { FormItemRule } from 'element-plus'
import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue'
import type {
  AiProviderConsoleMode,
  AiProviderCreateModelForm,
  AiProviderFormController,
  AiProviderModelCapabilityForm,
} from '../typing'
import type {
  AiProvider,
  AiProviderModelItem,
  UpsertAiProviderModelRequest,
} from '@/apis/ai'
import { AI_MODEL_CAPABILITY, AI_MODEL_MODALITY, AI_MODEL_TYPE } from '@haohaoxue/lexora-contracts/ai/constants'
import { computed, nextTick, reactive, shallowRef, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  discoverPlatformAiProviderModels,
  discoverUserAiProviderModels,
  getPlatformAiProviderModels,
  getUserAiProviderModels,
  upsertPlatformAiProviderModel,
  upsertPlatformAiProviderModels,
  upsertUserAiProviderModel,
  upsertUserAiProviderModels,
} from '@/apis/ai'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'

/**
 * 模型列表参数。
 */
export interface UseAiProviderModelsOptions {
  /** 控制台模式 */
  mode: MaybeRefOrGetter<AiProviderConsoleMode>
  /** 当前服务商 */
  selectedProvider: ComputedRef<AiProvider | null>
  /** 是否可编辑地址 */
  canEditEndpoint: ComputedRef<boolean>
  /** 更新模型数量缓存 */
  patchProviderModelCount: (providerId: string, modelCount: number) => void
  /** 保存地址 */
  saveEndpoint: () => Promise<boolean>
  /** 添加模型表单实例 */
  createModelFormRef: Readonly<Ref<AiProviderFormController | null>>
}

export function useAiProviderModels(options: UseAiProviderModelsOptions) {
  const { t } = useI18n({ useScope: 'global' })
  const models = shallowRef<AiProviderModelItem[]>([])
  const discoveredModels = shallowRef<AiProviderModelItem[]>([])
  const discoverSearchKeyword = shallowRef('')
  const isLoadingModels = shallowRef(false)
  const isDiscoveringModels = shallowRef(false)
  const isAddingDiscoveredModels = shallowRef(false)
  const isCreatingModel = shallowRef(false)
  const isSavingModelCapability = shallowRef(false)
  const discoverDialogVisible = shallowRef(false)
  const createModelDialogVisible = shallowRef(false)
  const modelCapabilityDialogVisible = shallowRef(false)
  const editingModel = shallowRef<AiProviderModelItem | null>(null)
  const updatingModelIds = shallowRef(new Set<string>())

  const createModelForm = reactive<AiProviderCreateModelForm>(createDefaultModelForm())
  const modelCapabilityForm = reactive<AiProviderModelCapabilityForm>(createDefaultModelForm())

  const requiredListRule: FormItemRule = {
    validator: (_rule, value: unknown, callback: (error?: Error) => void) => {
      if (Array.isArray(value) && value.length > 0) {
        callback()
        return
      }

      callback(new Error(t('aiProvider.validation.requireModality')))
    },
    trigger: 'change',
  }

  const createModelRules = createModelFormRules(createModelForm)
  const modelCapabilityRules = createModelFormRules(modelCapabilityForm)

  const totalModelCount = computed(() => models.value.length)
  const enabledModelCount = computed(() => models.value.filter(model => model.enabled).length)
  const discoverModelsButtonText = computed(() => t('aiProvider.discover.fetch'))
  const filteredDiscoveredModels = computed(() => {
    const keyword = discoverSearchKeyword.value.trim().toLowerCase()
    if (!keyword) {
      return discoveredModels.value
    }

    return discoveredModels.value.filter(model =>
      model.modelId.toLowerCase().includes(keyword)
      || model.modelName.toLowerCase().includes(keyword),
    )
  })
  const modelSummaryText = computed(() => {
    if (models.value.length > 0) {
      return t('aiProvider.model.summary', {
        enabled: enabledModelCount.value,
        total: models.value.length,
      })
    }

    return t('aiProvider.model.summaryEmpty')
  })
  const shouldShowModelsEmptyState = computed(() => !isLoadingModels.value && models.value.length === 0)

  async function loadModelsForSelectedProvider() {
    const provider = options.selectedProvider.value
    clearModels()

    if (!provider) {
      return
    }

    await loadModels(provider.providerId)
  }

  async function loadModels(providerId: string) {
    isLoadingModels.value = true

    try {
      const result = currentMode() === 'platform'
        ? await getPlatformAiProviderModels(providerId)
        : await getUserAiProviderModels(providerId)

      models.value = sortModels(result.models)
      options.patchProviderModelCount(providerId, result.models.length)
    }
    catch (error) {
      models.value = []
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.loadModels')))
    }
    finally {
      isLoadingModels.value = false
    }
  }

  function clearModels() {
    models.value = []
    discoveredModels.value = []
    discoverSearchKeyword.value = ''
  }

  async function openDiscoverModelsDialog() {
    const provider = options.selectedProvider.value
    if (!provider) {
      return
    }

    if (options.canEditEndpoint.value) {
      const saved = await options.saveEndpoint()
      if (!saved) {
        return
      }
    }

    discoverDialogVisible.value = true
    await refreshDiscoveredModels({ showSuccessMessage: false })
  }

  async function refreshDiscoveredModels(optionsOverride: {
    showSuccessMessage?: boolean
  } = {}) {
    const provider = options.selectedProvider.value
    if (!provider) {
      return
    }

    isDiscoveringModels.value = true

    try {
      const result = currentMode() === 'platform'
        ? await discoverPlatformAiProviderModels(provider.providerId)
        : await discoverUserAiProviderModels(provider.providerId)

      discoveredModels.value = result.models
      if (optionsOverride.showSuccessMessage ?? true) {
        ElMessage.success(t('aiProvider.messages.modelsDiscovered', { count: result.models.length }))
      }
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.discoverModels')))
    }
    finally {
      isDiscoveringModels.value = false
    }
  }

  async function addAllDiscoveredModels() {
    const provider = options.selectedProvider.value
    const targetModels = filteredDiscoveredModels.value
    if (!provider || targetModels.length === 0) {
      return
    }

    isAddingDiscoveredModels.value = true

    try {
      const result = currentMode() === 'platform'
        ? await upsertPlatformAiProviderModels(provider.providerId, {
            models: targetModels.map(model => buildUpsertModelPayload(model, true)),
          })
        : await upsertUserAiProviderModels(provider.providerId, {
            models: targetModels.map(model => buildUpsertModelPayload(model, true)),
          })
      const savedModelById = new Map(result.models.map(model => [model.modelId, model]))

      models.value = sortModels(result.models)
      discoveredModels.value = discoveredModels.value.map(model => savedModelById.get(model.modelId) ?? model)
      options.patchProviderModelCount(provider.providerId, result.models.length)
      ElMessage.success(t('aiProvider.messages.modelsAdded', { count: targetModels.length }))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.addAllModels')))
    }
    finally {
      isAddingDiscoveredModels.value = false
    }
  }

  async function updateModelStatus(model: AiProviderModelItem, value: string | number | boolean) {
    await upsertModelStatus(model, Boolean(value), t('aiProvider.errors.updateModelStatus'))
  }

  async function upsertModelStatus(model: AiProviderModelItem, enabled: boolean, errorMessage: string) {
    const provider = options.selectedProvider.value
    if (!provider) {
      return null
    }

    const updateKey = getModelUpdateKey(model)
    const nextUpdatingIds = new Set(updatingModelIds.value)
    nextUpdatingIds.add(updateKey)
    updatingModelIds.value = nextUpdatingIds

    try {
      const item = currentMode() === 'platform'
        ? await upsertPlatformAiProviderModel(provider.providerId, buildUpsertModelPayload(model, enabled))
        : await upsertUserAiProviderModel(provider.providerId, buildUpsertModelPayload(model, enabled))

      patchSavedModel(item)
      patchDiscoveredModel(item)
      return item
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, errorMessage))
      return null
    }
    finally {
      const nextIds = new Set(updatingModelIds.value)
      nextIds.delete(updateKey)
      updatingModelIds.value = nextIds
    }
  }

  function openCreateModelDialog() {
    Object.assign(createModelForm, createDefaultModelForm())
    createModelDialogVisible.value = true
    void nextTick(() => options.createModelFormRef.value?.clearValidate())
  }

  function handleCreateModelIdInput(value: string) {
    const previousModelId = createModelForm.modelId
    const shouldSyncModelName = !createModelForm.modelName || createModelForm.modelName === previousModelId

    createModelForm.modelId = value
    if (shouldSyncModelName) {
      createModelForm.modelName = value
    }
  }

  async function createModel() {
    const provider = options.selectedProvider.value
    if (!provider) {
      return
    }

    const isValid = await options.createModelFormRef.value?.validate().catch(() => false)
    if (!isValid) {
      return
    }

    isCreatingModel.value = true

    try {
      const item = currentMode() === 'platform'
        ? await upsertPlatformAiProviderModel(provider.providerId, buildFormModelPayload(createModelForm, true))
        : await upsertUserAiProviderModel(provider.providerId, buildFormModelPayload(createModelForm, true))

      patchSavedModel(item)
      patchDiscoveredModel(item)
      createModelDialogVisible.value = false
      ElMessage.success(t('aiProvider.messages.modelAdded'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.addModel')))
    }
    finally {
      isCreatingModel.value = false
    }
  }

  function openModelCapabilityDialog(model: AiProviderModelItem) {
    editingModel.value = model
    Object.assign(modelCapabilityForm, {
      modelId: model.modelId,
      modelName: model.modelName,
      modelType: model.modelType,
      inputModalities: [...model.inputModalities],
      outputModalities: [...model.outputModalities],
      capabilities: [...model.capabilities],
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    } satisfies AiProviderModelCapabilityForm)
    modelCapabilityDialogVisible.value = true
  }

  async function saveModelCapability() {
    const provider = options.selectedProvider.value
    const model = editingModel.value
    if (!provider || !model) {
      return
    }

    const updateKey = getModelUpdateKey(model)
    const nextUpdatingIds = new Set(updatingModelIds.value)
    nextUpdatingIds.add(updateKey)
    updatingModelIds.value = nextUpdatingIds
    isSavingModelCapability.value = true

    try {
      const item = currentMode() === 'platform'
        ? await upsertPlatformAiProviderModel(
            provider.providerId,
            buildFormModelPayload(modelCapabilityForm, model.enabled ?? false),
          )
        : await upsertUserAiProviderModel(
            provider.providerId,
            buildFormModelPayload(modelCapabilityForm, model.enabled ?? false),
          )

      patchSavedModel(item)
      patchDiscoveredModel(item)
      modelCapabilityDialogVisible.value = false
      editingModel.value = null
      ElMessage.success(t('aiProvider.messages.modelConfigSaved'))
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.saveModelConfig')))
    }
    finally {
      const nextIds = new Set(updatingModelIds.value)
      nextIds.delete(updateKey)
      updatingModelIds.value = nextIds
      isSavingModelCapability.value = false
    }
  }

  function patchSavedModel(item: AiProviderModelItem) {
    const exists = models.value.some(model => model.modelId === item.modelId)
    models.value = sortModels(exists
      ? models.value.map(model => model.modelId === item.modelId ? item : model)
      : [...models.value, item])
    options.patchProviderModelCount(item.providerId, models.value.length)
  }

  function patchDiscoveredModel(item: AiProviderModelItem) {
    if (!discoveredModels.value.some(model => model.modelId === item.modelId)) {
      return
    }

    discoveredModels.value = discoveredModels.value.map(model => model.modelId === item.modelId ? item : model)
  }

  function isModelUpdating(model: AiProviderModelItem) {
    return updatingModelIds.value.has(getModelUpdateKey(model))
  }

  function getModelUpdateKey(model: AiProviderModelItem) {
    return `${model.providerId}:${model.modelId}`
  }

  function buildUpsertModelPayload(model: AiProviderModelItem, enabled: boolean): UpsertAiProviderModelRequest {
    const payload: UpsertAiProviderModelRequest = {
      modelId: model.modelId,
      modelName: model.modelName,
      modelType: model.modelType,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
      capabilities: model.capabilities,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      enabled,
    }

    return payload
  }

  function buildFormModelPayload(form: AiProviderModelCapabilityForm, enabled: boolean): UpsertAiProviderModelRequest {
    const payload: UpsertAiProviderModelRequest = {
      modelId: form.modelId.trim(),
      modelName: form.modelName.trim(),
      modelType: form.modelType,
      inputModalities: [...form.inputModalities],
      outputModalities: [...form.outputModalities],
      capabilities: [...form.capabilities],
      contextWindow: form.contextWindow,
      maxOutputTokens: form.maxOutputTokens,
      enabled,
    }

    return payload
  }

  function createDefaultModelForm(): AiProviderCreateModelForm {
    return {
      modelId: '',
      modelName: '',
      modelType: AI_MODEL_TYPE.CHAT,
      inputModalities: [AI_MODEL_MODALITY.TEXT],
      outputModalities: [AI_MODEL_MODALITY.TEXT],
      capabilities: [AI_MODEL_CAPABILITY.STREAMING],
      contextWindow: null,
      maxOutputTokens: null,
    }
  }

  function sortModels(items: AiProviderModelItem[]) {
    return [...items].sort((left, right) =>
      left.modelName.localeCompare(right.modelName)
      || left.modelId.localeCompare(right.modelId),
    )
  }

  function currentMode() {
    return toValue(options.mode)
  }

  function createModelFormRules(form: AiProviderCreateModelForm | AiProviderModelCapabilityForm) {
    return {
      modelId: [{ required: true, message: t('aiProvider.validation.modelIdRequired'), trigger: 'blur' }],
      modelName: [{ required: true, message: t('aiProvider.validation.modelNameRequired'), trigger: 'blur' }],
      modelType: [{ required: true, message: t('aiProvider.validation.modelTypeRequired'), trigger: 'change' }],
      inputModalities: [requiredListRule, createModelModalitiesRule(form, 'input')],
      outputModalities: [requiredListRule, createModelModalitiesRule(form, 'output')],
      contextWindow: [createModelLimitRule(form)],
      maxOutputTokens: [createModelLimitRule(form)],
    }
  }

  function createModelModalitiesRule(
    form: AiProviderCreateModelForm | AiProviderModelCapabilityForm,
    target: 'input' | 'output',
  ): FormItemRule {
    return {
      validator: (_rule, _value: unknown, callback: (error?: Error) => void) => {
        const errorMessage = validateModelModalities(form, target)
        callback(errorMessage ? new Error(errorMessage) : undefined)
      },
      trigger: 'change',
    }
  }

  function createModelLimitRule(form: AiProviderCreateModelForm | AiProviderModelCapabilityForm): FormItemRule {
    return {
      validator: (_rule, _value: unknown, callback: (error?: Error) => void) => {
        if (form.contextWindow !== null && form.maxOutputTokens !== null && form.maxOutputTokens > form.contextWindow) {
          callback(new Error(t('aiProvider.validation.maxOutputLimit')))
          return
        }

        callback()
      },
      trigger: 'change',
    }
  }

  function validateModelModalities(
    form: AiProviderCreateModelForm | AiProviderModelCapabilityForm,
    target: 'input' | 'output',
  ) {
    if (form.modelType === AI_MODEL_TYPE.CHAT) {
      return requireModality(form, target, AI_MODEL_MODALITY.TEXT, target === 'input' ? t('aiProvider.validation.requireChatInput') : t('aiProvider.validation.requireChatOutput'))
    }
    if (form.modelType === AI_MODEL_TYPE.EMBEDDING) {
      return requireModality(form, target, target === 'input' ? AI_MODEL_MODALITY.TEXT : AI_MODEL_MODALITY.EMBEDDING, target === 'input' ? t('aiProvider.validation.requireEmbeddingInput') : t('aiProvider.validation.requireEmbeddingOutput'))
    }
    if (form.modelType === AI_MODEL_TYPE.RERANK) {
      return requireModality(form, target, AI_MODEL_MODALITY.TEXT, target === 'input' ? t('aiProvider.validation.requireRerankInput') : t('aiProvider.validation.requireRerankOutput'))
    }
    if (form.modelType === AI_MODEL_TYPE.IMAGE && target === 'output') {
      return requireModality(form, target, AI_MODEL_MODALITY.IMAGE, t('aiProvider.validation.requireImageOutput'))
    }
    if (form.modelType === AI_MODEL_TYPE.AUDIO && !form.inputModalities.includes(AI_MODEL_MODALITY.AUDIO) && !form.outputModalities.includes(AI_MODEL_MODALITY.AUDIO)) {
      return t('aiProvider.validation.requireAudioModality')
    }

    return null
  }

  function requireModality(
    form: AiProviderCreateModelForm | AiProviderModelCapabilityForm,
    target: 'input' | 'output',
    modality: typeof AI_MODEL_MODALITY[keyof typeof AI_MODEL_MODALITY],
    message: string,
  ) {
    const modalities = target === 'input' ? form.inputModalities : form.outputModalities
    return modalities.includes(modality) ? null : message
  }

  return {
    models,
    discoveredModels,
    discoverSearchKeyword,
    filteredDiscoveredModels,
    isLoadingModels,
    isDiscoveringModels,
    isAddingDiscoveredModels,
    isCreatingModel,
    isSavingModelCapability,
    discoverDialogVisible,
    createModelDialogVisible,
    modelCapabilityDialogVisible,
    updatingModelIds,
    createModelForm,
    modelCapabilityForm,
    createModelRules,
    modelCapabilityRules,
    totalModelCount,
    enabledModelCount,
    discoverModelsButtonText,
    modelSummaryText,
    shouldShowModelsEmptyState,
    loadModelsForSelectedProvider,
    clearModels,
    openDiscoverModelsDialog,
    refreshDiscoveredModels,
    addAllDiscoveredModels,
    openCreateModelDialog,
    handleCreateModelIdInput,
    createModel,
    openModelCapabilityDialog,
    saveModelCapability,
    updateModelStatus,
    isModelUpdating,
  }
}
