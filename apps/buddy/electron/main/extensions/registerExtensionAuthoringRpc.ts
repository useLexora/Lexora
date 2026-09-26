import type { ExtensionInspection } from '../../../shared/extensions/extensionAuthoring'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import { buildExtensionPackage } from '../../../platform/extensions/buildExtensionPackage'
import { EXTENSION_BUILD_RPC, EXTENSION_CAPABILITIES_RPC, EXTENSION_IDENTITY_RPC, EXTENSION_INSPECT_RPC, extensionCapabilitiesRequestSchema, extensionIdentityRequestSchema, extensionInspectionSchema, extensionInspectRequestSchema } from '../../../shared/extensions/extensionAuthoring'
import { createExtensionId } from '../../../shared/extensions/extensionIdentity'
import { EXTENSION_API_VERSION } from '../../../shared/extensions/extensionManifest'
import { queryWorkbenchCapabilities } from '../../../shared/workbench/workbenchUi'
import { compileExtension } from './compileExtension'

export function registerExtensionAuthoringRpc(peer: Pick<RuntimeRpcPeerContract, 'onRequest'>, inspect: (id: string) => Promise<ExtensionInspection>, author: () => string): () => void {
  const lifetime = new AbortController()
  let active = 0
  const stopIdentity = peer.onRequest(EXTENSION_IDENTITY_RPC, (input) => {
    const request = extensionIdentityRequestSchema.parse(input)
    return { id: createExtensionId(request.slug), author: request.author ?? author(), engines: { lexora: '>=0.9.0 <1.0.0' } }
  })
  const stopInspect = peer.onRequest(EXTENSION_INSPECT_RPC, async input => extensionInspectionSchema.parse(await inspect(extensionInspectRequestSchema.parse(input).id)))
  const stopCapabilities = peer.onRequest(EXTENSION_CAPABILITIES_RPC, async (input) => {
    const query = extensionCapabilitiesRequestSchema.parse(input)
    const targets = queryWorkbenchCapabilities(query)
    return { apiVersion: EXTENSION_API_VERSION, targets: query.kind || query.target ? targets : targets.map(({ kind, target, title, scope }) => ({ kind, target, title, scope })) }
  })
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
    stopCapabilities()
    stopIdentity()
  }
}
