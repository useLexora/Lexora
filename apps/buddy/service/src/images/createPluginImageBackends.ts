import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ProviderService } from '../providers/ProviderService'
import type { ImageReadingBackend } from './ImageReadingService'
import type { PluginImageGateway } from './PluginImageGateway'
import type { ImageGenerationBackend } from './RoutedImageGateway'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { extensionImageReaderSchema, extensionImageReadingRequestSchema, extensionImageReadingResultSchema, extensionImageReadingRpc, imageReadingLimits } from '../../../shared/extensions/extensionImageReading'
import { extensionInvocationContext } from '../plugins/extensionInvocationContext'
import { ImageGenerationError } from './ImageGenerationGateway'
import { ImageReadingError, validateReadingImage } from './ImageReadingService'

export function createPluginImageBackends(rpc: RuntimeRpcPeerContract, providers: Pick<ProviderService, 'isPluginModelEnabled'>, gateway: PluginImageGateway): { reading: ImageReadingBackend, generation: ImageGenerationBackend } {
  const readers = async (signal?: AbortSignal) => extensionImageReaderSchema.array().max(512).parse(await rpc.request(extensionImageReadingRpc.list, {}, 30000, signal))
  return {
    reading: {
      candidates: async () => (await readers()).map(model => ({ target: { kind: 'plugin', extensionId: model.extensionId, modelId: model.id }, title: model.title, owner: model.extensionName, available: providers.isPluginModelEnabled(model.extensionId, model.id), managementPage: model.managementPage, support: model.support })),
      read: async (target, input, requestId) => {
        const plugin = (await readers(input.signal)).find(model => target.kind === 'plugin' && model.extensionId === target.extensionId && model.id === target.modelId && model.support.operations.includes(input.operation))
        if (!plugin || !providers.isPluginModelEnabled(plugin.extensionId, plugin.id) || input.images.length !== 1)
          throw new ImageReadingError('IMAGE_READING_UNSUPPORTED', true)
        const image = input.images[0]!.image
        const request = extensionImageReadingRequestSchema.parse({ requestId, model: plugin.id, operation: input.operation, ...(input.operation !== 'extract' && input.request !== undefined ? { currentUserRequest: input.request } : {}), question: input.question, image: { mimeType: image.mimeType, data: image.data } })
        if (Buffer.byteLength(JSON.stringify(request)) > imageReadingLimits.inputBytes)
          throw new ImageReadingError('IMAGE_READING_UNSUPPORTED', true)
        await validateReadingImage(image, input.signal)
        const parent = extensionInvocationContext.getStore()
        const result = extensionImageReadingResultSchema.parse(await rpc.request(extensionImageReadingRpc.invoke, { id: randomUUID(), target: plugin, request, ...(parent ? { parentInvocationId: parent.invocationId } : {}) }, null, input.signal))
        if (result.status === 'failed')
          throw new ImageReadingError('IMAGE_READING_FAILED', result.retryable)
        return { text: result.text, title: plugin.title, owner: plugin.extensionName }
      },
    },
    generation: {
      candidates: async signal => (await gateway.models(signal)).map(model => ({ target: { kind: 'plugin', extensionId: model.extensionId, modelId: model.id }, title: model.title, owner: model.providerName ?? model.extensionName, available: providers.isPluginModelEnabled(model.extensionId, model.id), managementPage: model.managementPage, support: model.support })),
      generate: async (target, input) => {
        const plugin = (await gateway.models(input.signal)).find(model => target.kind === 'plugin' && model.extensionId === target.extensionId && model.id === target.modelId)
        if (!plugin || !providers.isPluginModelEnabled(plugin.extensionId, plugin.id))
          throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
        return gateway.generate(plugin, input)
      },
    },
  }
}
