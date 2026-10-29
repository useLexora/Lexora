import type { ProviderSpeechConnection, ProviderSpeechRequest } from '../../shared/providers/providerSpeechApi'
import type { SpeechPreferences, SpeechProvider } from '../../shared/speech/speechApi'
import type { SyncTransport } from '../sync/SyncAdapter'
import type { SpeechBackend, SpeechInvocation } from './SpeechBackend'
import { createHash } from 'node:crypto'
import { requestSpeech } from './requestSpeech'
import { speechCapabilities } from './speechCapabilities'
import { speechVoices } from './speechCatalogOptions'

function id(model: ProviderSpeechConnection): string {
  return `service:${createHash('sha256').update(JSON.stringify([model.providerId, model.modelId, model.kind])).digest('hex')}`
}
interface ProviderSpeechBackendOptions {
  models: () => Promise<ProviderSpeechConnection[]>
  prepareRequest: (model: ProviderSpeechConnection, signal: AbortSignal) => Promise<ProviderSpeechRequest>
  preferences: () => Promise<SpeechPreferences>
  request: SyncTransport
  onChanged: (listener: () => void) => () => void
}

export class ProviderSpeechBackend implements SpeechBackend {
  readonly options: ProviderSpeechBackendOptions
  constructor(options: ProviderSpeechBackendOptions) {
    this.options = options
  }

  onChanged = (listener: () => void) => this.options.onChanged(listener)
  async list(): Promise<SpeechProvider[]> {
    return (await this.options.models()).map(model => ({
      id: id(model),
      providerId: model.providerId,
      modelId: model.modelId,
      title: model.displayName ?? model.modelId,
      source: model.providerName,
      kind: model.kind,
      revision: model.revision,
      supported: model.enabled && model.modelEnabled !== false && model.available !== false,
      unavailableReason: !model.enabled ? 'provider_disabled' : model.available === false ? 'model_unavailable' : model.modelEnabled === false ? 'model_disabled' : undefined,
      streamingInput: false,
      streamingOutput: false,
      ...speechCapabilities(model.baseUrl, model.kind),
    }))
  }

  async #resolve(provider: SpeechProvider): Promise<ProviderSpeechConnection> {
    const model = (await this.options.models()).find(item => id(item) === provider.id && item.revision === provider.revision)
    if (!model?.enabled || model.modelEnabled === false || model.available === false)
      throw new Error('SPEECH_PROVIDER_UNAVAILABLE')
    return model
  }

  async voices(provider: SpeechProvider) {
    const model = await this.#resolve(provider)
    return speechVoices(model.baseUrl, model.modelId)
  }

  async prepare(provider: SpeechProvider): Promise<void> { await this.#resolve(provider) }
  async invoke(provider: SpeechProvider, invocation: SpeechInvocation): Promise<void> {
    const model = await this.#resolve(provider)
    const request = await this.options.prepareRequest(model, invocation.signal)
    const preferences = (await this.options.preferences()).voiceSettings?.[provider.id]
    await requestSpeech({ language: (await this.options.preferences()).transcriptionSettings?.[provider.id]?.language, ...request, modelId: model.modelId, voice: preferences?.voice, rate: preferences?.rate, request: this.options.request }, invocation)
  }
}
