import type { LocalCustomProvider, LocalCustomProviderModel } from '@buddy-shared/providers/providerApi'
import type { ModelCapabilityOverrides } from '@buddy-shared/providers/providerCapabilities'
import type { ModelCatalogReference } from '@buddy-shared/providers/providerCatalog'
import type { ProviderRequestHeader } from '@buddy-shared/providers/providerHeaders'
import type { ProviderModelType } from '@buddy-shared/providers/providerModelType'
import type { ModelParameters } from '../../state/typing'

export interface ManualModelEditorActions {
  saveManualModel: (model: LocalCustomProviderModel) => Promise<boolean>
}

export interface ModelParameterActions extends ManualModelEditorActions {
  saveType: (type: ProviderModelType | null) => Promise<boolean>
  saveCapabilities: (capabilities: ModelCapabilityOverrides | null) => Promise<boolean>
  selectCatalogSource: (source: ModelCatalogReference | null) => Promise<boolean>
  saveParameters: (parameters: ModelParameters) => Promise<boolean>
  restoreParameters: () => Promise<boolean>
  acknowledgeSourceUpdate: () => Promise<boolean>
}

export interface ProviderConnectionActions {
  clearError: () => void
  rename: (providerId: string, displayName: string, requestHeaders?: readonly ProviderRequestHeader[]) => Promise<boolean>
  save: (provider: LocalCustomProvider) => Promise<boolean>
}
