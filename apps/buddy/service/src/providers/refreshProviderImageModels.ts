import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ProviderService } from './ProviderService'
import { extensionImageModelSchema, extensionImageRpc } from '../../../shared/extensions/extensionImage'
import { extensionImageReaderSchema, extensionImageReadingRpc } from '../../../shared/extensions/extensionImageReading'

export async function refreshProviderImageModels(options: { rpc: RuntimeRpcPeerContract, providers: ProviderService, signal?: AbortSignal }): Promise<void> {
  const [images, readers] = await Promise.all([
    options.rpc.request(extensionImageRpc.list, {}, 30000, options.signal).then(value => extensionImageModelSchema.array().max(512).parse(value)),
    options.rpc.request(extensionImageReadingRpc.list, {}, 30000, options.signal).then(value => extensionImageReaderSchema.array().max(512).parse(value)),
  ])
  options.signal?.throwIfAborted()
  options.providers.setCapabilityModels([
    ...images.map(model => ({ ...model, kind: 'image.generate' as const })),
    ...readers.map(model => ({ ...model, kind: 'image.read' as const })),
  ].map(model => ({
    providerId: `plugin:${model.extensionId}`,
    modelId: model.id,
    title: model.title,
    kind: model.kind,
    available: true,
    plugin: { id: model.extensionId, name: model.providerName ?? model.extensionName, managementPage: model.managementPage },
  })), 'images')
}
