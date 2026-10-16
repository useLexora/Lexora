import type { CascaderOption } from 'element-plus'
import type {
  AiAvailableModelOption,
  AiAvailableProviderOption,
  AiModelIntentKey,
  AiModelRef,
  AiProviderScope,
} from '@/apis/ai'

export type ModelCascaderProvidersLoader = (
  intentKey: AiModelIntentKey,
  scope: AiProviderScope,
) => Promise<AiAvailableProviderOption[]>

export type ModelCascaderModelsLoader = (
  intentKey: AiModelIntentKey,
  providerId: string,
) => Promise<AiAvailableModelOption[]>

export interface ModelCascaderModelRef {
  providerId: string
  modelId: string
  scope?: AiProviderScope
  providerKey?: string
}

export interface ModelCascaderProps {
  modelValue?: ModelCascaderModelRef | null
  intentKey: AiModelIntentKey
  placeholder?: string
  disabled?: boolean
  clearable?: boolean
  filterable?: boolean
  showAllLevels?: boolean
  popperClass?: string
  allowedScopes?: AiProviderScope[]
  hideUnavailable?: boolean
  availableProvidersLoader?: ModelCascaderProvidersLoader
  availableProviderModelsLoader?: ModelCascaderModelsLoader
}

export interface ModelCascaderEmits {
  'update:modelValue': [value: AiModelRef | null]
}

export interface ModelCascaderOption extends CascaderOption {
  nodeKind: 'scope' | 'provider' | 'model'
  scope?: AiProviderScope
  providerId?: string
  providerKey?: string
  modelId?: string
  unavailableReason?: string | null
}
