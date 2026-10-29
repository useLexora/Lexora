export interface ProviderCapabilityModel {
  providerId: string
  modelId: string
  kind: 'speech.transcribe' | 'speech.synthesize'
  available: boolean
  plugin?: { id: string, name: string, managementPage: boolean }
}
