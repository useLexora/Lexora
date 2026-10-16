import type { MaybeRefOrGetter, Ref } from 'vue'
import type { AiProviderConsoleMode, AiProviderFormController, AiProviderRow } from '../typing'
import { onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import {
  getProviderInitial,
  getProviderStatusType,
} from '../utils/providerDisplay'
import { useAiCompatibleProviders } from './useAiCompatibleProviders'
import { useAiProviderCatalog } from './useAiProviderCatalog'
import { useAiProviderCredentials } from './useAiProviderCredentials'
import { useAiProviderModels } from './useAiProviderModels'
import { useAiProviderStatus } from './useAiProviderStatus'

/**
 * AI 服务商控制台参数。
 */
export interface UseAiProviderConsoleOptions {
  /** 控制台模式 */
  mode: MaybeRefOrGetter<AiProviderConsoleMode>
  /** 创建服务商表单实例 */
  createCompatibleProviderFormRef: Readonly<Ref<AiProviderFormController | null>>
  /** 编辑服务商表单实例 */
  editCompatibleProviderFormRef: Readonly<Ref<AiProviderFormController | null>>
  /** 添加模型表单实例 */
  createModelFormRef: Readonly<Ref<AiProviderFormController | null>>
}

export function useAiProviderConsole(options: UseAiProviderConsoleOptions) {
  const { t } = useI18n({ useScope: 'global' })
  const isLoading = shallowRef(false)

  const catalog = useAiProviderCatalog({
    mode: options.mode,
  })

  const credentials = useAiProviderCredentials({
    mode: options.mode,
    selectedProvider: catalog.selectedProvider,
    patchProvider: catalog.patchProvider,
  })

  const models = useAiProviderModels({
    mode: options.mode,
    selectedProvider: catalog.selectedProvider,
    canEditEndpoint: credentials.canEditEndpoint,
    patchProviderModelCount: catalog.patchProviderModelCount,
    saveEndpoint: credentials.saveEndpoint,
    createModelFormRef: options.createModelFormRef,
  })

  const status = useAiProviderStatus({
    mode: options.mode,
    selectedProvider: catalog.selectedProvider,
    enabledModelCount: models.enabledModelCount,
    patchProvider: catalog.patchProvider,
  })

  const compatibleProviders = useAiCompatibleProviders({
    mode: options.mode,
    ensureCompatiblePresets: catalog.ensureCompatiblePresets,
    providers: catalog.providers,
    selectedRowKey: catalog.selectedRowKey,
    selectCatalogRow: catalog.selectRow,
    createCompatibleProviderFormRef: options.createCompatibleProviderFormRef,
    editCompatibleProviderFormRef: options.editCompatibleProviderFormRef,
    selectRow,
    patchProvider: catalog.patchProvider,
    removeProvider: catalog.removeProvider,
    normalizeSelectedRow: catalog.normalizeSelectedRow,
    syncCredentialForms: credentials.syncCredentialForms,
    loadApiKeyForSelectedProvider: credentials.loadApiKeyForSelectedProvider,
    loadModelsForSelectedProvider: models.loadModelsForSelectedProvider,
    clearModels: models.clearModels,
  })

  onMounted(() => {
    void loadInitialData()
  })

  async function loadInitialData() {
    isLoading.value = true

    try {
      await catalog.loadCatalog()
      credentials.syncCredentialForms()
      await Promise.all([
        credentials.loadApiKeyForSelectedProvider(),
        models.loadModelsForSelectedProvider(),
      ])
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, t('aiProvider.errors.loadProviders')))
    }
    finally {
      isLoading.value = false
    }
  }

  async function selectRow(rowKey: string) {
    catalog.selectRow(rowKey)
    credentials.syncCredentialForms()
    await Promise.all([
      credentials.loadApiKeyForSelectedProvider(),
      models.loadModelsForSelectedProvider(),
    ])
  }

  function handleRowContextMenu(row: AiProviderRow) {
    if (catalog.selectedRowKey.value === row.rowKey) {
      return
    }

    void selectRow(row.rowKey)
  }

  return {
    compatiblePresets: catalog.compatiblePresets,
    filteredRows: catalog.filteredRows,
    selectedRowKey: catalog.selectedRowKey,
    searchKeyword: catalog.searchKeyword,
    isLoading,
    isLoadingModels: models.isLoadingModels,
    isDiscoveringModels: models.isDiscoveringModels,
    isAddingDiscoveredModels: models.isAddingDiscoveredModels,
    isCreatingModel: models.isCreatingModel,
    isSavingModelCapability: models.isSavingModelCapability,
    isUpdatingProviderStatus: status.isUpdatingProviderStatus,
    isSavingEndpoint: credentials.isSavingEndpoint,
    isSavingApiKey: credentials.isSavingApiKey,
    isLoadingApiKey: credentials.isLoadingApiKey,
    isCreatingCompatibleProvider: compatibleProviders.isCreatingCompatibleProvider,
    isUpdatingCompatibleProvider: compatibleProviders.isUpdatingCompatibleProvider,
    createCompatibleProviderDialogVisible: compatibleProviders.createCompatibleProviderDialogVisible,
    editCompatibleProviderDialogVisible: compatibleProviders.editCompatibleProviderDialogVisible,
    discoverDialogVisible: models.discoverDialogVisible,
    createModelDialogVisible: models.createModelDialogVisible,
    modelCapabilityDialogVisible: models.modelCapabilityDialogVisible,
    updatingModelIds: models.updatingModelIds,
    endpointForm: credentials.endpointForm,
    apiKeyForm: credentials.apiKeyForm,
    compatibleProviderCreateForm: compatibleProviders.compatibleProviderCreateForm,
    compatibleProviderEditForm: compatibleProviders.compatibleProviderEditForm,
    createModelForm: models.createModelForm,
    modelCapabilityForm: models.modelCapabilityForm,
    models: models.models,
    discoveredModels: models.discoveredModels,
    filteredDiscoveredModels: models.filteredDiscoveredModels,
    discoverSearchKeyword: models.discoverSearchKeyword,
    selectedRow: catalog.selectedRow,
    selectedProvider: catalog.selectedProvider,
    canEditEndpoint: credentials.canEditEndpoint,
    requiresApiKey: credentials.requiresApiKey,
    selectedTitle: catalog.selectedTitle,
    discoverModelsButtonText: models.discoverModelsButtonText,
    modelSummaryText: models.modelSummaryText,
    shouldShowModelsEmptyState: models.shouldShowModelsEmptyState,
    compatibleProviderCreateRules: compatibleProviders.compatibleProviderCreateRules,
    compatibleProviderEditRules: compatibleProviders.compatibleProviderEditRules,
    createModelRules: models.createModelRules,
    modelCapabilityRules: models.modelCapabilityRules,
    selectRow,
    openCreateCompatibleProviderDialog: compatibleProviders.openCreateCompatibleProviderDialog,
    createCompatibleProvider: compatibleProviders.createCompatibleProvider,
    updateCompatibleProvider: compatibleProviders.updateCompatibleProvider,
    handleCompatibleProviderCommand: compatibleProviders.handleCompatibleProviderCommand,
    saveApiKey: credentials.saveApiKey,
    saveEndpoint: credentials.saveEndpoint,
    updateProviderEnabled: status.updateProviderEnabled,
    openDiscoverModelsDialog: models.openDiscoverModelsDialog,
    refreshDiscoveredModels: models.refreshDiscoveredModels,
    addAllDiscoveredModels: models.addAllDiscoveredModels,
    openCreateModelDialog: models.openCreateModelDialog,
    handleCreateModelIdInput: models.handleCreateModelIdInput,
    createModel: models.createModel,
    openModelCapabilityDialog: models.openModelCapabilityDialog,
    saveModelCapability: models.saveModelCapability,
    updateModelStatus: models.updateModelStatus,
    isModelUpdating: models.isModelUpdating,
    getProviderInitial,
    getProviderStatusType,
    handleRowContextMenu,
  }
}
