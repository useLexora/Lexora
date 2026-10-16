import type { FormRules } from 'element-plus'
import type {
  AiModelCapability,
  AiModelModality,
  AiModelType,
  AiProvider,
  AiProviderModelItem,
  AiProviderPreset,
} from '@/apis/ai'

export const COMPATIBLE_PROVIDER_KEYS = ['openai-compatible', 'anthropic-compatible'] as const

export type CompatibleProviderKey = typeof COMPATIBLE_PROVIDER_KEYS[number]

export type AiProviderConsoleMode = 'platform' | 'user'

export interface AiProviderRow {
  rowKey: string
  kind: 'preset' | 'compatible'
  providerKey: string
  title: string
  provider: AiProvider
}

export interface AiProviderFormController {
  validate: () => Promise<boolean>
  clearValidate: () => void
}

export interface AiProviderEndpointForm {
  endpoint: string
}

export interface AiProviderApiKeyForm {
  apiKey: string
}

export interface AiCompatibleProviderForm {
  providerKey: CompatibleProviderKey
  providerName: string
}

export interface AiCompatibleProviderEditForm extends AiCompatibleProviderForm {
  providerId: string
}

export interface AiProviderModelCapabilityForm {
  modelId: string
  modelName: string
  modelType: AiModelType
  inputModalities: AiModelModality[]
  outputModalities: AiModelModality[]
  capabilities: AiModelCapability[]
  contextWindow: number | null
  maxOutputTokens: number | null
}

export type AiProviderCreateModelForm = AiProviderModelCapabilityForm

export type AiProviderFormRules = FormRules

export type AiProviderStatusType = 'success' | 'info'

export type AiProviderModelStatusChange = (
  model: AiProviderModelItem,
  value: string | number | boolean,
) => void | Promise<void>

export type AiProviderModelConfigure = (
  model: AiProviderModelItem,
) => void | Promise<void>

export type AiProviderRowCommand = 'edit' | 'delete'

export type {
  AiProvider,
  AiProviderModelItem,
  AiProviderPreset,
}
