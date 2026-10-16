import type {
  AiAvailableModelOption,
  AiAvailableProviderOption,
  AiDefaultModelPolicyItem,
  AiModelIntentKey,
  AiProvider,
  AiProviderCredential,
  AiProviderModelItem,
  AiProviderModels,
  AiProviderPreset,
  AiProviderScope,
  CreateAiProviderRequest,
  UpdateAiDefaultModelPolicyRequest,
  UpdateAiProviderRequest,
  UpsertAiProviderModelRequest,
  UpsertAiProviderModelsRequest,
} from './typing'
import { axios } from '@/utils/axios'

export * from './typing'

export function getAiCompatibleProviderPresets(): Promise<AiProviderPreset[]> {
  return axios.request({
    method: 'get',
    url: '/ai/provider-presets/compatible',
  })
}

export function getPlatformAiProviders(): Promise<AiProvider[]> {
  return axios.request({
    method: 'get',
    url: '/system-admin/ai/providers',
  })
}

export function getPlatformEmbeddingAiModel(): Promise<AiDefaultModelPolicyItem> {
  return axios.request({
    method: 'get',
    url: '/system-admin/ai/platform-embedding-model',
  })
}

export function updatePlatformEmbeddingAiModel(
  data: UpdateAiDefaultModelPolicyRequest,
): Promise<AiDefaultModelPolicyItem> {
  return axios.request({
    method: 'put',
    url: '/system-admin/ai/platform-embedding-model',
    data,
  })
}

export function getPlatformEmbeddingAvailableAiProviders(): Promise<AiAvailableProviderOption[]> {
  return axios.request({
    method: 'get',
    url: '/system-admin/ai/platform-embedding-model/available/providers',
  })
}

export function getPlatformEmbeddingAvailableAiProviderModels(
  _intentKey: AiModelIntentKey,
  providerId: string,
): Promise<AiAvailableModelOption[]> {
  return axios.request({
    method: 'get',
    url: `/system-admin/ai/platform-embedding-model/available/providers/${providerId}/models`,
  })
}

export function createPlatformAiProvider(data: CreateAiProviderRequest): Promise<AiProvider> {
  return axios.request({
    method: 'post',
    url: '/system-admin/ai/providers',
    data,
  })
}

export function updatePlatformAiProvider(
  providerId: string,
  data: UpdateAiProviderRequest,
): Promise<AiProvider> {
  return axios.request({
    method: 'patch',
    url: `/system-admin/ai/providers/${providerId}`,
    data,
  })
}

export function getPlatformAiProviderCredential(providerId: string): Promise<AiProviderCredential> {
  return axios.request({
    method: 'get',
    url: `/system-admin/ai/providers/${providerId}/credential`,
  })
}

export function deletePlatformAiProvider(providerId: string): Promise<void> {
  return axios.request({
    method: 'delete',
    url: `/system-admin/ai/providers/${providerId}`,
  })
}

export function getPlatformAiProviderModels(providerId: string): Promise<AiProviderModels> {
  return axios.request({
    method: 'get',
    url: `/system-admin/ai/providers/${providerId}/models`,
  })
}

export function discoverPlatformAiProviderModels(
  providerId: string,
): Promise<AiProviderModels> {
  return axios.request({
    method: 'post',
    url: `/system-admin/ai/providers/${providerId}/models/discover`,
  })
}

export function upsertPlatformAiProviderModel(
  providerId: string,
  data: UpsertAiProviderModelRequest,
): Promise<AiProviderModelItem> {
  return axios.request({
    method: 'post',
    url: `/system-admin/ai/providers/${providerId}/models`,
    data,
  })
}

export function upsertPlatformAiProviderModels(
  providerId: string,
  data: UpsertAiProviderModelsRequest,
): Promise<AiProviderModels> {
  return axios.request({
    method: 'put',
    url: `/system-admin/ai/providers/${providerId}/models`,
    data,
  })
}

export function getUserAiProviders(): Promise<AiProvider[]> {
  return axios.request({
    method: 'get',
    url: '/users/me/ai/providers',
  })
}

export function createUserAiProvider(data: CreateAiProviderRequest): Promise<AiProvider> {
  return axios.request({
    method: 'post',
    url: '/users/me/ai/providers',
    data,
  })
}

export function updateUserAiProvider(
  providerId: string,
  data: UpdateAiProviderRequest,
): Promise<AiProvider> {
  return axios.request({
    method: 'patch',
    url: `/users/me/ai/providers/${providerId}`,
    data,
  })
}

export function getUserAiProviderCredential(providerId: string): Promise<AiProviderCredential> {
  return axios.request({
    method: 'get',
    url: `/users/me/ai/providers/${providerId}/credential`,
  })
}

export function deleteUserAiProvider(providerId: string): Promise<void> {
  return axios.request({
    method: 'delete',
    url: `/users/me/ai/providers/${providerId}`,
  })
}

export function getUserAiProviderModels(providerId: string): Promise<AiProviderModels> {
  return axios.request({
    method: 'get',
    url: `/users/me/ai/providers/${providerId}/models`,
  })
}

export function discoverUserAiProviderModels(
  providerId: string,
): Promise<AiProviderModels> {
  return axios.request({
    method: 'post',
    url: `/users/me/ai/providers/${providerId}/models/discover`,
  })
}

export function upsertUserAiProviderModel(
  providerId: string,
  data: UpsertAiProviderModelRequest,
): Promise<AiProviderModelItem> {
  return axios.request({
    method: 'post',
    url: `/users/me/ai/providers/${providerId}/models`,
    data,
  })
}

export function upsertUserAiProviderModels(
  providerId: string,
  data: UpsertAiProviderModelsRequest,
): Promise<AiProviderModels> {
  return axios.request({
    method: 'put',
    url: `/users/me/ai/providers/${providerId}/models`,
    data,
  })
}

export function getAvailableAiModels(intentKey: AiModelIntentKey): Promise<AiAvailableModelOption[]> {
  return axios.request({
    method: 'get',
    url: '/users/me/ai/models/available',
    params: { intentKey },
  })
}

export function getAvailableAiProviders(
  intentKey: AiModelIntentKey,
  scope: AiProviderScope,
): Promise<AiAvailableProviderOption[]> {
  return axios.request({
    method: 'get',
    url: '/users/me/ai/models/available/providers',
    params: { intentKey, scope },
  })
}

export function getAvailableAiProviderModels(
  intentKey: AiModelIntentKey,
  providerId: string,
): Promise<AiAvailableModelOption[]> {
  return axios.request({
    method: 'get',
    url: `/users/me/ai/models/available/providers/${providerId}/models`,
    params: { intentKey },
  })
}
