export interface ProviderCapabilityModel {
  providerId: string
  modelId: string
  kind: 'speech.transcribe' | 'speech.synthesize' | 'image.generate' | 'image.read'
  title?: string
  available: boolean
  plugin?: { id: string, name: string, managementPage: boolean }
}
