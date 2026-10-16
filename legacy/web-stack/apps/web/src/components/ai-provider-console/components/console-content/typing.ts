import type {
  AiProvider,
  AiProviderApiKeyForm,
  AiProviderEndpointForm,
  AiProviderModelConfigure,
  AiProviderModelItem,
  AiProviderModelStatusChange,
  AiProviderRow,
} from '../../typing'

export interface AiProviderConsoleContentProps {
  selectedRow: AiProviderRow | null
  selectedTitle: string
  selectedProvider: AiProvider | null
  endpointForm: AiProviderEndpointForm
  apiKeyForm: AiProviderApiKeyForm
  canEditEndpoint: boolean
  requiresApiKey: boolean
  isUpdatingProviderStatus: boolean
  isSavingEndpoint: boolean
  isSavingApiKey: boolean
  isLoadingApiKey: boolean
  models: AiProviderModelItem[]
  modelSummaryText: string
  discoverModelsButtonText: string
  shouldShowEmptyState: boolean
  isLoadingModels: boolean
  isDiscoveringModels: boolean
  isModelUpdating: (model: AiProviderModelItem) => boolean
}

export interface AiProviderConsoleContentEmits {
  updateProviderEnabled: [value: string | number | boolean]
  saveEndpoint: []
  saveApiKey: []
  openDiscoverModels: []
  openCreateModel: []
  updateModelStatus: Parameters<AiProviderModelStatusChange>
  configureModel: Parameters<AiProviderModelConfigure>
}
