import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { registerExtensionIpc } from './registerExtensionIpc'
import { Buffer } from 'node:buffer'
import { extensionImageReadingEventSchema, extensionImageReadingInvocationSchema, extensionImageReadingRpc, imageReadingLimits } from '../../../shared/extensions/extensionImageReading'
import { inferenceLimits } from '../../../shared/extensions/extensionInference'

export function registerExtensionImageReadingRpc(peer: RuntimeRpcPeerContract, getInference: () => ReturnType<typeof registerExtensionIpc>['inference'] | null) {
  const disposers = [
    peer.onRequest(extensionImageReadingRpc.list, () => getInference()?.imageReaders() ?? []),
    peer.onRequest(extensionImageReadingRpc.invoke, async (raw, signal = new AbortController().signal) => {
      const { id, target, request, parentInvocationId } = extensionImageReadingInvocationSchema.parse(raw)
      const encoded = Buffer.from(JSON.stringify(request))
      if (encoded.byteLength > imageReadingLimits.inputBytes)
        throw new Error('EXTENSION_INFERENCE_INPUT_TOO_LARGE')
      let started = false
      let terminal: 'done' | 'failed' | undefined
      let retryable = false
      let text = ''
      let sequence = 0
      try {
        const inference = getInference()
        if (!inference)
          throw new Error('EXTENSION_INFERENCE_UNAVAILABLE')
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
            for (let offset = 0; offset < encoded.length; offset += inferenceLimits.chunkBytes)
              yield encoded.subarray(offset, offset + inferenceLimits.chunkBytes)
          })(),
          event(data, bytes) {
            const event = extensionImageReadingEventSchema.parse(data)
            if (terminal || bytes.byteLength)
              throw new Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
            if (event.type === 'text') {
              if (event.sequence !== sequence++ || Buffer.byteLength(text) + Buffer.byteLength(event.text) > imageReadingLimits.textBytes)
                throw new Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
              text += event.text
            }
            else {
              terminal = event.type
              retryable = event.type === 'failed' && event.retryable
            }
          },
        })
        signal.throwIfAborted()
        return terminal === 'done' ? { status: 'completed', text } : { status: 'failed', retryable: terminal === 'failed' && retryable && !text }
      }
      catch {
        signal.throwIfAborted()
        return { status: 'failed', retryable: !started }
      }
    }),
  ]
  return () => disposers.forEach(dispose => dispose())
}
