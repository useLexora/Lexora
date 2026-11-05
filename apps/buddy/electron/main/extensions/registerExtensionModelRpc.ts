import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { registerExtensionIpc } from './registerExtensionIpc'
import { Buffer } from 'node:buffer'
import { extensionChatEventSchema, extensionChatInvocationSchema, extensionChatMaxBytes, extensionChatRpc } from '../../../shared/extensions/extensionChat'
import { inferenceLimits } from '../../../shared/extensions/extensionInference'

export function registerExtensionModelRpc(peer: RuntimeRpcPeerContract, getInference: () => ReturnType<typeof registerExtensionIpc>['inference'] | null) {
  const disposers = [
    peer.onRequest(extensionChatRpc.list, () => getInference()?.models() ?? []),
    peer.onRequest(extensionChatRpc.invoke, async (raw, signal = new AbortController().signal) => {
      try {
        const { id, target, capabilities, request, parentInvocationId } = extensionChatInvocationSchema.parse(raw)
        const inference = getInference()
        if (!inference)
          throw new Error('EXTENSION_INFERENCE_UNAVAILABLE')
        const encoded = Buffer.from(JSON.stringify(request))
        if (encoded.byteLength > extensionChatMaxBytes)
          throw new Error('EXTENSION_INFERENCE_CONTEXT_TOO_LARGE')
        if (!capabilities.image && request.messages.some(message => 'content' in message && message.content.some(part => part.type === 'image')))
          throw new Error('EXTENSION_INFERENCE_INPUT_UNSUPPORTED')
        if (!capabilities.toolCall && request.tools.length)
          throw new Error('EXTENSION_INFERENCE_TOOL_INVALID')
        await inference.invoke(target.extensionId, target.revision, {
          id,
          capability: target.capability,
          generation: target.generation,
          bindingRevision: target.bindingRevision,
          parentInvocationId,
          input: { model: target.id, contentType: 'application/json' },
          signal,
          chunks: (async function* () {
            for (let offset = 0; offset < encoded.byteLength; offset += inferenceLimits.chunkBytes)
              yield encoded.subarray(offset, offset + inferenceLimits.chunkBytes)
          })(),
          event: async (data, bytes, lifetime) => {
            if (bytes.byteLength)
              throw new Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
            const event = extensionChatEventSchema.parse(data)
            if (event.type === 'tool' && !capabilities.toolCall)
              throw new Error('EXTENSION_INFERENCE_TOOL_INVALID')
            await peer.request(extensionChatRpc.event, { id, event }, 30000, lifetime)
          },
        })
        return null
      }
      catch (error) {
        return { error: error instanceof Error && /^EXTENSION_INFERENCE_[A-Z_]{1,80}$/.test(error.message) ? error.message : 'EXTENSION_INFERENCE_BACKEND_FAILED' }
      }
    }),
  ]
  return () => disposers.forEach(dispose => dispose())
}
