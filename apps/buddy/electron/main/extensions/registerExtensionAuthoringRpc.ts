import type { ExtensionInspection } from '../../../shared/extensions/extensionAuthoring'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import { buildExtensionPackage } from '../../../platform/extensions/buildExtensionPackage'
import { EXTENSION_BUILD_RPC, EXTENSION_INSPECT_RPC, extensionInspectionSchema, extensionInspectRequestSchema } from '../../../shared/extensions/extensionAuthoring'
import { compileExtension } from './compileExtension'

export function registerExtensionAuthoringRpc(peer: RuntimeRpcPeerContract, inspect: (id: string) => Promise<ExtensionInspection>): () => void {
  const lifetime = new AbortController()
  let active = 0
  const stopInspect = peer.onRequest(EXTENSION_INSPECT_RPC, async input => extensionInspectionSchema.parse(await inspect(extensionInspectRequestSchema.parse(input).id)))
  const stop = peer.onRequest(EXTENSION_BUILD_RPC, async (input, signal) => {
    if (active >= 2)
      return { ok: false, code: 'EXTENSION_COMPILER_BUSY', diagnostics: [] }
    active++
    try {
      return await buildExtensionPackage(input, compileExtension, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal)
    }
    finally { active-- }
  })
  return () => {
    lifetime.abort()
    stop()
    stopInspect()
  }
}
