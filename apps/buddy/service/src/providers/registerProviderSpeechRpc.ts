import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { WorkspaceRepository } from '../storage/workspaceRepository'
import type { ProviderService } from './ProviderService'
import { createHash } from 'node:crypto'
import { speechKindForModel } from '../../../shared/providers/providerModelType'
import { PROVIDER_SPEECH_SETTINGS_KEY, providerSpeechModelSchema, providerSpeechRpc } from '../../../shared/providers/providerSpeechApi'
import { HOST_SPEECH_MODELS, speechProviderDescriptorSchema } from '../../../shared/speech/speechApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

interface SpeechRegistryOptions { rpc: RuntimeRpcPeerContract, providers: ProviderService, workspace: WorkspaceRepository }

export async function refreshProviderSpeechModels(options: SpeechRegistryOptions): Promise<void> {
  const local = speechProviderDescriptorSchema.array().max(512).parse(await options.rpc.request(HOST_SPEECH_MODELS, {}))
  options.providers.setCapabilityModels(local.flatMap(model => model.providerId ? [{ providerId: model.providerId, modelId: model.modelId ?? model.id, kind: model.kind, available: model.supported, ...(model.settings ? { plugin: { id: model.settings.extensionId, name: model.source ?? model.title, managementPage: model.settings.page } } : {}) }] : []))
  const legacy = options.workspace.get(PROVIDER_SPEECH_SETTINGS_KEY)
  if (!legacy)
    return
  const providers = await options.providers.listProviders()
  const models = await options.providers.listModels()
  const pending = []
  for (const model of providerSpeechModelSchema.array().parse(legacy)) {
    if (!providers.some(provider => provider.id === model.providerId)) {
      pending.push(model)
      continue
    }
    if (!models.some(item => item.providerId === model.providerId && item.id === model.modelId))
      await options.providers.upsertManualModel(model.providerId, { id: model.modelId, type: model.kind === 'speech.transcribe' ? 'transcription' : 'speech' })
  }
  if (pending.length)
    options.workspace.set(PROVIDER_SPEECH_SETTINGS_KEY, pending, new Date().toISOString())
  else
    options.workspace.delete(PROVIDER_SPEECH_SETTINGS_KEY)
}

export function registerProviderSpeechRpc(options: SpeechRegistryOptions): () => void {
  const connections = async () => {
    await refreshProviderSpeechModels(options)
    const providers = await options.providers.listProviders()
    const models = await options.providers.listModels()
    return models.flatMap((model) => {
      const kind = speechKindForModel(model.type)
      const provider = providers.find(item => item.id === model.providerId)
      if (!kind || !provider?.baseUrl || provider.plugin || model.api !== 'openai-audio')
        return []
      const connection = { providerId: model.providerId, modelId: model.id, displayName: model.displayName, kind, api: 'openai-audio' as const, providerName: provider.displayName, baseUrl: provider.baseUrl, enabled: provider.enabled && provider.status === 'available', modelEnabled: model.enabled, available: model.available }
      const configuration = JSON.stringify([connection, provider.requestHeaders, provider.storedCredentialType])
      return [{ configuration, connection: { ...connection, revision: createHash('sha256').update(JSON.stringify([configuration, options.providers.getCredentialMetadata(provider.id)])).digest('hex') } }]
    })
  }
  const releaseList = registerRuntimeRequest(options.rpc, providerSpeechRpc.list, async () => (await connections()).map(item => item.connection))
  const releasePrepare = registerRuntimeRequest(options.rpc, providerSpeechRpc.prepare, async (input, signal) => {
    const entries = await connections()
    const selected = entries.find(({ connection }) => connection.providerId === input.providerId && connection.modelId === input.modelId && connection.kind === input.kind)
    if (!selected || selected.connection.revision !== input.revision || !selected.connection.enabled || !selected.connection.modelEnabled || !selected.connection.available)
      return { status: 'error' as const, code: 'SPEECH_PROVIDER_UNAVAILABLE' as const }
    let request
    try {
      request = await options.providers.prepareModelRequest(input.providerId, signal)
    }
    catch {
      signal?.throwIfAborted()
      return { status: 'error' as const, code: 'SPEECH_SERVICE_UNAUTHORIZED' as const }
    }
    signal?.throwIfAborted()
    const current = (await connections()).find(({ connection }) => connection.providerId === input.providerId && connection.modelId === input.modelId && connection.kind === input.kind)
    if (current?.configuration !== selected.configuration)
      return { status: 'error' as const, code: 'SPEECH_PROVIDER_UNAVAILABLE' as const }
    return { status: 'ready' as const, request }
  })
  return () => {
    releaseList()
    releasePrepare()
  }
}
