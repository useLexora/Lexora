import type { BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { LocalBuiltinProviderPreset, LocalCustomProvider, LocalCustomProviderModel, LocalDefaultModel, LocalModelSnapshot, LocalProvider, LocalProviderAuthChallenge, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { ModelCapabilityOverrides } from '@buddy-shared/providers/providerCapabilities'
import type { ModelCatalogReference } from '@buddy-shared/providers/providerCatalog'
import type { ProviderRequestHeader } from '@buddy-shared/providers/providerHeaders'
import type { Ref } from 'vue'
import type { BuddyLocale } from '@/i18n/buddyI18n'

export interface ModelParameters {
  contextWindow: number
  maxTokens: number
}

export interface ModelProvidersStore {
  builtinPresets: Readonly<Ref<ReadonlyArray<LocalBuiltinProviderPreset>>>
  authChallenge: Readonly<Ref<LocalProviderAuthChallenge | null>>
  defaultEffort: Readonly<Ref<BuddyThinkingLevel | null>>
  defaultModelId: Readonly<Ref<string | null>>
  isAuthenticating: Readonly<Ref<boolean>>
  isLoadingModelCatalog: Readonly<Ref<boolean>>
  isRefreshingModelSnapshot: Readonly<Ref<boolean>>
  language: Readonly<Ref<BuddyLocale>>
  modelProviderError: Readonly<Ref<string | null>>
  models: Readonly<Ref<ReadonlyArray<LocalRuntimeModelOption>>>
  modelSnapshot: Readonly<Ref<LocalModelSnapshot | null>>
  mutatingProviderId: Readonly<Ref<string | null>>
  providers: Readonly<Ref<ReadonlyArray<LocalProvider>>>
  registeredModels: Readonly<Ref<ReadonlyArray<LocalRuntimeModelOption>>>
  syncingProviderId: Readonly<Ref<string | null>>
  acknowledgeModelSourceUpdate: (providerId: string, modelId: string) => Promise<boolean>
  addProvider: (providerId: string) => Promise<LocalProvider | null>
  createCustomProvider: (provider: LocalCustomProvider) => Promise<LocalProvider | 'conflict' | null>
  renameProvider: (providerId: string, displayName: string, requestHeaders?: readonly ProviderRequestHeader[]) => Promise<boolean>
  cancelAuth: (challengeId: string) => Promise<void>
  clearModelProviderError: () => void
  clearProviderCredential: (providerId: string) => Promise<boolean>
  dispose: () => void
  loadModelCatalog: (force?: boolean) => Promise<boolean>
  loginProvider: (providerId: string, authType: 'api_key' | 'oauth') => Promise<boolean>
  logoutProvider: (providerId: string) => Promise<boolean>
  openModelSnapshotDirectory: () => Promise<boolean>
  rememberModelSelection: (value: LocalDefaultModel | null) => Promise<boolean>
  removeModel: (providerId: string, modelId: string) => Promise<boolean>
  removeProvider: (providerId: string) => Promise<boolean>
  respondToAuth: (challengeId: string, value: string) => Promise<boolean>
  refreshModelSnapshot: () => Promise<boolean>
  restoreModelSourceParameters: (providerId: string, modelId: string) => Promise<boolean>
  setDefaultEffort: (value: BuddyThinkingLevel | null) => Promise<boolean>
  setDefaultModel: (value: string | null) => Promise<boolean>
  setModelParameters: (providerId: string, modelId: string, parameters: ModelParameters) => Promise<boolean>
  setModelCatalogSource: (providerId: string, modelId: string, source: ModelCatalogReference | null) => Promise<boolean>
  setModelCapabilities: (providerId: string, modelId: string, capabilities: ModelCapabilityOverrides | null) => Promise<boolean>
  setProviderEnabled: (providerId: string, enabled: boolean) => Promise<boolean>
  setProviderModelEnabled: (providerId: string, modelId: string, enabled: boolean) => Promise<boolean>
  syncProviderModels: (providerId: string) => Promise<boolean>
  upsertCustomProvider: (provider: LocalCustomProvider) => Promise<boolean>
  upsertManualModel: (providerId: string, model: LocalCustomProviderModel) => Promise<boolean>
}
