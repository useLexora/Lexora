import type {
  AiProviderModelConfigure,
  AiProviderModelItem,
  AiProviderModelStatusChange,
} from '../../typing'

export interface AiProviderModelTableProps {
  models: AiProviderModelItem[]
  isModelUpdating: (model: AiProviderModelItem) => boolean
  canConfigure: boolean
}

export interface AiProviderModelTableEmits {
  updateModelStatus: Parameters<AiProviderModelStatusChange>
  configureModel: Parameters<AiProviderModelConfigure>
}
