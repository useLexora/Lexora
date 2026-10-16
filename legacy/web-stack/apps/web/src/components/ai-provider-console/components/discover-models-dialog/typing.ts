import type { AiProviderModelItem, AiProviderModelStatusChange } from '../../typing'

export interface AiProviderDiscoverModelsDialogProps {
  title: string
  models: AiProviderModelItem[]
  isDiscovering: boolean
  isAdding: boolean
  isModelUpdating: (model: AiProviderModelItem) => boolean
}

export interface AiProviderDiscoverModelsDialogEmits {
  addAll: []
  refresh: []
  updateModelStatus: Parameters<AiProviderModelStatusChange>
}
