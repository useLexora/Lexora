import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { registerExtensionIpc } from './registerExtensionIpc'
import { Buffer } from 'node:buffer'
import { ExtensionLaunchStorageError } from '../../../platform/extensions/extensionLaunchStorage'
import { inferenceStorageFailure } from '../../../platform/extensions/inferenceStorageFailure'
import { inferenceDiagnosticCodeSchema } from '../../../shared/diagnostics/inferenceDiagnostic'
import { InferenceInvocationDiagnostic } from '../../../shared/diagnostics/inferenceInvocationDiagnostic'
import { extensionChatEventSchema, extensionChatInvocationSchema, extensionChatLaunchErrorSchema, extensionChatMaxBytes, extensionChatRpc } from '../../../shared/extensions/extensionChat'
import { inferenceLimits } from '../../../shared/extensions/extensionInference'
import { launchLocationExtensionId } from '../../../shared/extensions/extensionLaunchLocation'

export function registerExtensionModelRpc(peer: RuntimeRpcPeerContract, getInference: () => ReturnType<typeof registerExtensionIpc>['inference'] | null, report?: ApplicationDiagnosticReporter) {
  const disposers = [
    peer.onRequest(extensionChatRpc.list, () => getInference()?.models() ?? []),
    peer.onRequest(extensionChatRpc.invoke, async (raw, signal = new AbortController().signal) => {
      const diagnostic = new InferenceInvocationDiagnostic(report, raw && typeof raw === 'object' && 'id' in raw ? raw.id : undefined)
      diagnostic.mark('host.received')
      diagnostic.stage = 'host.validate'
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
        diagnostic.stage = 'host.dispatch'
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
        const storageCode = inferenceStorageFailure(error)
        diagnostic.failed(error, storageCode)
        if (storageCode) {
          const location = error instanceof ExtensionLaunchStorageError ? error.location : undefined
          return { error: storageCode, ...(launchLocationExtensionId(location) ? { location } : {}) }
        }
        const code = error instanceof Error ? inferenceDiagnosticCodeSchema.safeParse(error.message).data : undefined
        return { error: code && !extensionChatLaunchErrorSchema.safeParse(code).success ? code : 'EXTENSION_INFERENCE_BACKEND_FAILED' }
      }
    }),
  ]
  return () => disposers.forEach(dispose => dispose())
}
