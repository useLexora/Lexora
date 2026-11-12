import type { ExtensionChatCapabilities, ExtensionChatEvent, ExtensionChatRequest, ExtensionModel } from '../../../shared/extensions/extensionChat'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ProviderService } from './ProviderService'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { extensionChatEventSchema, extensionChatMaxBytes, extensionChatRpc, extensionModelSchema, pluginProviderId } from '../../../shared/extensions/extensionChat'
import { extensionInvocationContext } from '../plugins/extensionInvocationContext'
import { createPluginProvider } from './createPluginProvider'
import { refreshProviderImageModels } from './refreshProviderImageModels'

export class PluginModelRegistry {
  readonly #stop = new AbortController()
  readonly #events = new Map<string, (event: ExtensionChatEvent) => void>()
  readonly #revisions = new Map<string, string>()
  readonly #dispose: (() => void)[]
  #refreshing: Promise<void> | undefined
  #dirty = false
  readonly rpc: RuntimeRpcPeerContract
  readonly providers: ProviderService
  constructor(rpc: RuntimeRpcPeerContract, providers: ProviderService, failed: () => void) {
    this.rpc = rpc
    this.providers = providers
    const metadata = providers.onDidChangeMetadata((event) => {
      if (event.kind === 'accepted')
        void this.refresh().catch(failed)
    })
    this.#dispose = [
      () => metadata.dispose(),
      rpc.onRequest(extensionChatRpc.event, (raw) => {
        const { id, event } = z.object({ id: z.uuid(), event: extensionChatEventSchema }).strict().parse(raw)
        const handler = this.#events.get(id)
        if (!handler)
          throw new Error('EXTENSION_INFERENCE_CANCELLED')
        handler(event)
        return null
      }),
      rpc.onNotification((method) => {
        if (method === extensionChatRpc.changed)
          void this.refresh().catch(failed)
      }),
    ]
  }

  refresh(): Promise<void> {
    this.#dirty = true
    return this.#refreshing ??= (async () => {
      while (this.#dirty && !this.#stop.signal.aborted) {
        this.#dirty = false
        const [descriptors] = await Promise.all([
          this.rpc.request(extensionChatRpc.list, {}, 30000, this.#stop.signal).then(value => z.array(extensionModelSchema).max(512).parse(value)),
          refreshProviderImageModels({ rpc: this.rpc, providers: this.providers, signal: this.#stop.signal }),
        ])
        this.#stop.signal.throwIfAborted()
        const groups = new Map<string, ExtensionModel[]>()
        for (const descriptor of descriptors) {
          const id = pluginProviderId(descriptor.extensionId)
          const models = groups.get(id) ?? []
          if (models.some(model => model.id === descriptor.id))
            throw new Error('EXTENSION_INFERENCE_MODEL_INVALID')
          models.push(descriptor)
          groups.set(id, models)
        }
        for (const id of new Set([...this.providers.pluginProviderIds(), ...groups.keys()])) {
          const models = groups.get(id)
          const resolved = new Map(models?.map(model => [model.id, this.providers.resolvePluginModel(model)]))
          const revision = JSON.stringify([models ?? [], [...resolved]])
          if (revision === this.#revisions.get(id))
            continue
          const provider = models?.length ? createPluginProvider(models, (...args) => this.#invoke(...args), model => resolved.get(model.id)!) : undefined
          await this.providers.applyPluginProvider(id, provider, models)
          this.#revisions.set(id, revision)
        }
      }
    })().finally(() => { this.#refreshing = undefined })
  }

  async #invoke(target: ExtensionModel, request: ExtensionChatRequest, signal: AbortSignal, event: (event: ExtensionChatEvent) => void, capabilities: ExtensionChatCapabilities): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(request)) > extensionChatMaxBytes)
      throw new Error('EXTENSION_INFERENCE_CONTEXT_TOO_LARGE')
    const parent = extensionInvocationContext.getStore()
    const lifetime = AbortSignal.any([signal, this.#stop.signal, ...parent ? [parent.signal] : []])
    const id = randomUUID()
    this.#events.set(id, event)
    try {
      const result = await this.rpc.request(extensionChatRpc.invoke, { id, target, capabilities, request, ...(parent ? { parentInvocationId: parent.invocationId } : {}) }, null, lifetime)
      const failure = z.object({ error: z.string().regex(/^EXTENSION_INFERENCE_[A-Z_]{1,80}$/) }).strict().nullable().parse(result)
      if (failure)
        throw new Error(failure.error)
    }
    finally { this.#events.delete(id) }
  }

  async dispose(): Promise<void> {
    this.#stop.abort()
    this.#dispose.forEach(dispose => dispose())
    await this.#refreshing?.catch(() => {})
    this.#events.clear()
  }
}
