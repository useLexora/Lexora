import type {
  AiModelCapability,
  AiModelModality,
  AiModelType,
} from '@haohaoxue/lexora-contracts'

export type {
  AiAvailableModelOption,
  AiAvailableProviderOption,
  AiDefaultModelPolicyItem,
  AiModelCapability,
  AiModelIntentKey,
  AiModelModality,
  AiModelRef,
  AiModelType,
  AiProvider,
  AiProviderCredential,
  AiProviderEndpointMode,
  AiProviderModelItem,
  AiProviderModels,
  AiProviderPreset,
  AiProviderScope,
  UpdateAiDefaultModelPolicyRequest,
} from '@haohaoxue/lexora-contracts'

/**
 * 创建服务商请求。
 */
export interface CreateAiProviderRequest {
  /** 服务商键 */
  providerKey: string
  /** 服务商名称 */
  providerName?: string
  /** API 地址 */
  endpoint?: string
  /** API 密钥 */
  apiKey?: string
}

/**
 * 更新服务商请求。
 */
export interface UpdateAiProviderRequest {
  /** 服务商键 */
  providerKey?: string
  /** 服务商名称 */
  providerName?: string
  /** API 地址 */
  endpoint?: string
  /** API 密钥 */
  apiKey?: string
  /** 清空 API 密钥 */
  clearApiKey?: boolean
  /** 是否启用 */
  enabled?: boolean
}

/**
 * 创建模型项请求。
 */
export interface UpsertAiProviderModelRequest {
  /** 模型 ID */
  modelId: string
  /** 模型名称 */
  modelName: string
  /** 模型类型 */
  modelType?: AiModelType
  /** 模型能力 */
  capabilities?: AiModelCapability[]
  /** 输入模态 */
  inputModalities?: AiModelModality[]
  /** 输出模态 */
  outputModalities?: AiModelModality[]
  /** 上下文窗口 */
  contextWindow?: number | null
  /** 最大输出 token */
  maxOutputTokens?: number | null
  /** 是否启用 */
  enabled?: boolean
}

export interface UpsertAiProviderModelsRequest {
  /** 模型列表 */
  models: UpsertAiProviderModelRequest[]
}
