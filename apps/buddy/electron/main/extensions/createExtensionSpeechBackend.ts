import type { ExtensionService } from '../../../platform/extensions/ExtensionService'
import type { SpeechBackend } from '../../../platform/speech/SpeechBackend'
import process from 'node:process'
import { supportsInferenceRuntime } from '../../../shared/extensions/inferencePlatform'

export function createExtensionSpeechBackend(inference: {
  list: ExtensionService['inferenceSpeechModels']
  prepare: ExtensionService['prepareInference']
  invoke: ExtensionService['invokeInference']
}, onChanged: NonNullable<SpeechBackend['onChanged']>): SpeechBackend {
  const resolve = async (id: string, revision: string) => {
    const item = (await inference.list()).find(item => `extension:${item.extensionId}:${item.id}` === id && `${item.revision}:${item.bindingRevision}` === revision)
    if (!item)
      throw new Error('SPEECH_PROVIDER_UNAVAILABLE')
    return item
  }
  const translateError = (error: unknown): never => {
    const message = error instanceof Error ? error.message : ''
    const code = message.includes('NOT_CONFIGURED')
      ? 'NOT_CONFIGURED'
      : /CREDENTIAL_UNAVAILABLE|SERVICE_UNAUTHORIZED/.test(message)
        ? 'SERVICE_UNAUTHORIZED'
        : message.includes('SERVICE_BUSY')
          ? 'SERVICE_BUSY'
          : message.includes('NETWORK_FAILED') ? 'SERVICE_DISCONNECTED' : 'FAILED'
    throw new Error(`SPEECH_${code}`, { cause: error })
  }
  return {
    onChanged,
    list: async () => (await inference.list()).flatMap(item => item.kind !== 'speech.transcribe' && item.kind !== 'speech.synthesize'
      ? []
      : [{
          id: `extension:${item.extensionId}:${item.id}`,
          title: item.title,
          source: item.providerName ?? item.extensionName,
          providerId: `plugin:${item.extensionId}`,
          revision: `${item.revision}:${item.bindingRevision}`,
          modelId: item.id,
          kind: item.kind,
          streamingInput: item.streamingInput,
          streamingOutput: item.streamingOutput,
          settings: { extensionId: item.extensionId, page: item.managementPage },
          supported: supportsInferenceRuntime(item, process.platform, process.arch),
        }]),
    prepare: async (provider) => {
      const item = await resolve(provider.id, provider.revision)
      await inference.prepare(item.extensionId, item.revision, item.id).catch(translateError)
    },
    invoke: async (provider, { kind: _kind, ...input }) => {
      const item = await resolve(provider.id, provider.revision)
      await inference.invoke(item.extensionId, item.revision, { ...input, capability: item.id }).catch(translateError)
    },
  }
}
