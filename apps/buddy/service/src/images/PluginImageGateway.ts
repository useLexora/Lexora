import type { ExtensionImageEvent, ExtensionImageModel } from '../../../shared/extensions/extensionImage'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ImageGenerationInput, ImageGenerationResult } from './ImageGenerationGateway'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { extensionImageEventSchema, extensionImageLimits, extensionImageModelSchema, extensionImageRequestSchema, extensionImageRpc } from '../../../shared/extensions/extensionImage'
import { imageOutputOptionsSchema } from '../../../shared/images/imagePreferences'
import { extensionInvocationContext } from '../plugins/extensionInvocationContext'
import { ImageGenerationError } from './ImageGenerationGateway'

export class PluginImageGateway {
  readonly #events = new Map<string, (event: ExtensionImageEvent, bytes: Uint8Array) => Promise<void>>()
  readonly #stop = new AbortController()
  readonly #dispose: () => void
  readonly rpc: RuntimeRpcPeerContract
  constructor(rpc: RuntimeRpcPeerContract) {
    this.rpc = rpc
    this.#dispose = rpc.onRequest(extensionImageRpc.event, async (raw) => {
      const { id, event, bytes } = z.object({ id: z.uuid(), event: extensionImageEventSchema, bytes: z.string().max(350000).regex(/^[a-z0-9+/]*={0,2}$/i) }).strict().parse(raw)
      const handle = this.#events.get(id)
      if (!handle)
        throw new Error('EXTENSION_INFERENCE_CANCELLED')
      await handle(event, Buffer.from(bytes, 'base64'))
      return null
    })
  }

  async models(signal?: AbortSignal): Promise<ExtensionImageModel[]> {
    return z.array(extensionImageModelSchema).max(512).parse(await this.rpc.request(extensionImageRpc.list, {}, 30000, signal))
  }

  async generate(target: ExtensionImageModel, input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const id = randomUUID()
    const requestId = input.requestId ?? randomUUID()
    const request = extensionImageRequestSchema.parse({ requestId, model: target.id, operation: input.inputImages.length ? 'edit' : 'generate', prompt: input.prompt, images: input.inputImages.map(({ data, mimeType }) => ({ data, mimeType })), output: imageOutputOptionsSchema.parse(input.output ?? {}) })
    if (Buffer.byteLength(JSON.stringify(request)) > extensionImageLimits.inputBytes)
      throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { retryable: true })
    const parent = extensionInvocationContext.getStore()
    const signal = AbortSignal.any([input.signal, this.#stop.signal, ...parent ? [parent.signal] : []])
    let backendId = requestId
    let terminal: Extract<ExtensionImageEvent, { type: 'done' | 'failed' }> | undefined
    let total = 0
    const images: Array<{ chunks: Uint8Array[], complete: boolean, sequence: number }> = []
    const incomplete = (providerCode?: string) => new ImageGenerationError('IMAGE_GENERATION_INCOMPLETE', { diagnostic: { requestId: backendId, ...(providerCode && /^EXTENSION_INFERENCE_[A-Z_]{1,80}$/.test(providerCode) ? { providerCode } : {}) } })
    this.#events.set(id, async (event, bytes) => {
      if (terminal)
        throw incomplete()
      if (event.type === 'submitted') {
        backendId = event.requestId
        await input.onSubmitted?.(backendId)
      }
      else if (event.type === 'image') {
        total += bytes.byteLength
        if (!bytes.byteLength || total > extensionImageLimits.outputBytes || event.index > images.length)
          throw incomplete()
        if (event.index === images.length) {
          if (images.some(image => !image.complete))
            throw incomplete()
          images.push({ chunks: [], complete: false, sequence: 0 })
        }
        const image = images[event.index]!
        if (image.complete || event.sequence !== image.sequence++)
          throw incomplete()
        image.chunks.push(bytes)
        image.complete = event.final
      }
      else {
        terminal = event
      }
    })
    try {
      const raw = await this.rpc.request(extensionImageRpc.invoke, { id, target, request, ...(parent ? { parentInvocationId: parent.invocationId } : {}) }, null, signal)
      signal.throwIfAborted()
      const failure = z.object({ started: z.boolean(), error: z.string() }).strict().nullable().parse(raw)
      if (failure) {
        if (failure.started || total)
          throw incomplete(failure.error)
        throw new ImageGenerationError(failure.error === 'EXTENSION_INFERENCE_RESOURCE_EXHAUSTED' ? 'IMAGE_GENERATION_RESOURCE_EXHAUSTED' : failure.error === 'EXTENSION_INFERENCE_BUSY' ? 'IMAGE_GENERATION_BUSY' : 'IMAGE_GENERATION_FAILED', { retryable: true, diagnostic: { requestId, providerCode: failure.error } })
      }
      const result = terminal as ExtensionImageEvent | undefined
      if (result?.type === 'failed' && !total)
        throw new ImageGenerationError(result.code === 'RESOURCE_EXHAUSTED' ? 'IMAGE_GENERATION_RESOURCE_EXHAUSTED' : result.code === 'BUSY' ? 'IMAGE_GENERATION_BUSY' : result.code === 'UNSUPPORTED' ? 'IMAGE_GENERATION_UNSUPPORTED' : 'IMAGE_GENERATION_FAILED', { retryable: result.retryable, outcome: 'failed', diagnostic: { requestId: backendId, providerCode: result.code } })
      if (result?.type !== 'done' || !images.length || images.some(image => !image.complete))
        throw incomplete()
      return {
        responseId: result.responseId,
        images: images.map((image) => {
          const bytes = Buffer.concat(image.chunks)
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw incomplete()
          return { bytes, mimeType: 'image/png' }
        }),
      }
    }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof ImageGenerationError)
        throw error
      throw incomplete()
    }
    finally { this.#events.delete(id) }
  }

  dispose() {
    this.#stop.abort()
    this.#dispose()
    this.#events.clear()
  }
}
