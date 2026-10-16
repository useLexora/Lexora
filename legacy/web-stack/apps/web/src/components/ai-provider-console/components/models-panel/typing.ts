import type {
  AiProviderModelConfigure,
  AiProviderModelItem,
  AiProviderModelStatusChange,
} from '../../typing'

export interface AiProviderModelsPanelProps {
  models: AiProviderModelItem[]
  modelSummaryText: string
  discoverModelsButtonText: string
  shouldShowEmptyState: boolean
  isLoadingModels: boolean
  isDiscoveringModels: boolean
  isModelUpdating: (model: AiProviderModelItem) => boolean
}

export interface AiProviderModelsPanelEmits {
  openDiscoverModels: []
  openCreateModel: []
  updateModelStatus: Parameters<AiProviderModelStatusChange>
  configureModel: Parameters<AiProviderModelConfigure>
}
