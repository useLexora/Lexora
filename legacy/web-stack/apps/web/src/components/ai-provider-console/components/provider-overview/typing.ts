import type {
  AiProvider,
  AiProviderApiKeyForm,
  AiProviderEndpointForm,
} from '../../typing'

export interface AiProviderOverviewProps {
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
}

export interface AiProviderOverviewEmits {
  updateProviderEnabled: [value: string | number | boolean]
  saveEndpoint: []
  saveApiKey: []
}
