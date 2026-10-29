import type { SyncTransport } from '../../../platform/sync/SyncAdapter'
import type { SpeechPreferences } from '../../../shared/speech/speechApi'
import { ProviderSpeechBackend } from '../../../platform/speech/ProviderSpeechBackend'
import { providerSpeechRpc } from '../../../shared/providers/providerSpeechApi'

export function createProviderSpeechBackend(options: {
  request: (method: string, input: unknown, signal?: AbortSignal) => Promise<unknown>
  onChanged: (listener: () => void) => () => void
  preferences: () => Promise<SpeechPreferences>
  transport: SyncTransport
}): ProviderSpeechBackend {
  const list = async () => providerSpeechRpc.list.response.parse(await options.request(providerSpeechRpc.list.method, {}))
  return new ProviderSpeechBackend({
    models: list,
    onChanged: options.onChanged,
    prepareRequest: async (model, signal) => {
      const result = providerSpeechRpc.prepare.response.parse(await options.request(providerSpeechRpc.prepare.method, { providerId: model.providerId, modelId: model.modelId, kind: model.kind, api: model.api, revision: model.revision }, signal))
      if (result.status === 'error')
        throw new Error(result.code)
      return result.request
    },
    preferences: options.preferences,
    request: options.transport,
  })
}
