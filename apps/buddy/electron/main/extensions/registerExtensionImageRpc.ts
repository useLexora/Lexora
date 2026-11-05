import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { registerExtensionIpc } from './registerExtensionIpc'
import { Buffer } from 'node:buffer'
import { extensionImageEventSchema, extensionImageInvocationSchema, extensionImageLimits, extensionImageRpc } from '../../../shared/extensions/extensionImage'
import { inferenceLimits } from '../../../shared/extensions/extensionInference'

export function registerExtensionImageRpc(peer: RuntimeRpcPeerContract, getInference: () => ReturnType<typeof registerExtensionIpc>['inference'] | null) {
  const disposers = [
    peer.onRequest(extensionImageRpc.list, () => getInference()?.imageModels() ?? []),
    peer.onRequest(extensionImageRpc.invoke, async (raw, signal = new AbortController().signal) => {
      let started = false
      try {
        const { id, target, request, parentInvocationId } = extensionImageInvocationSchema.parse(raw)
        const inference = getInference()
        if (!inference)
          throw new Error('EXTENSION_INFERENCE_UNAVAILABLE')
        const encoded = Buffer.from(JSON.stringify(request))
        if (encoded.byteLength > extensionImageLimits.inputBytes)
          throw new Error('EXTENSION_INFERENCE_INPUT_TOO_LARGE')
        await inference.invoke(target.extensionId, target.revision, {
          id,
          capability: target.capability,
          generation: target.generation,
          bindingRevision: target.bindingRevision,
          parentInvocationId,
          input: { model: target.id, contentType: 'application/json' },
          signal,
          ready: () => { started = true },
          chunks: (async function* () {
            for (let offset = 0; offset < encoded.byteLength; offset += inferenceLimits.chunkBytes)
              yield encoded.subarray(offset, offset + inferenceLimits.chunkBytes)
          })(),
          event: async (data, bytes, lifetime) => {
            const event = extensionImageEventSchema.parse(data)
            if (event.type !== 'image' && bytes.byteLength)
              throw new Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
            await peer.request(extensionImageRpc.event, { id, event, bytes: Buffer.from(bytes).toString('base64') }, 30000, lifetime)
          },
        })
        return null
      }
      catch (error) {
        return { started, error: error instanceof Error && error.message === 'EXTENSION_REQUEST_LIMIT' ? 'EXTENSION_INFERENCE_BUSY' : error instanceof Error && /^EXTENSION_INFERENCE_[A-Z_]{1,80}$/.test(error.message) ? error.message : 'EXTENSION_INFERENCE_BACKEND_FAILED' }
      }
    }),
  ]
  return () => disposers.forEach(dispose => dispose())
}
