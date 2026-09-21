import type { RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { RuntimePreferences } from '../../../../shared/runtime/runtimePreferences'
import { runtimePreferencesRpc, runtimePreferencesSchema } from '../../../../shared/runtime/runtimePreferences'

export async function bindRuntimePreferences(
  rpc: Pick<RuntimeRpcPeerContract, 'request' | 'onNotification'>,
  apply: (preferences: RuntimePreferences) => void,
): Promise<() => void> {
  let updated = false
  const unsubscribe = rpc.onNotification((method, params) => {
    if (method !== runtimePreferencesRpc.changed)
      return
    updated = true
    apply(runtimePreferencesSchema.parse(params))
  })
  try {
    const preferences = runtimePreferencesSchema.parse(await rpc.request(runtimePreferencesRpc.get, {}))
    if (!updated)
      apply(preferences)
    return unsubscribe
  }
  catch (error) {
    unsubscribe()
    throw error
  }
}
