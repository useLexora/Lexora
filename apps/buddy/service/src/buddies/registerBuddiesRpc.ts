import type { BuddyToolOption } from '../../../shared/buddies/buddyApi'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { BuddiesService } from './BuddiesService'
import { buddiesRpc } from '../../../shared/buddies/buddyApi'
import { BuddyServiceError, registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerBuddiesRpc(rpc: RuntimeRequestRegistrar, service: BuddiesService, toolOptions?: (signal?: AbortSignal) => Promise<BuddyToolOption[]>): () => void {
  const disposers = [
    registerRuntimeRequest(rpc, buddiesRpc.toolOptions, (_input, signal) => {
      if (!toolOptions)
        throw new BuddyServiceError('BUDDY_CAPABILITY_UNAVAILABLE')
      return toolOptions(signal)
    }),
    registerRuntimeRequest(rpc, buddiesRpc.list, () => service.list()),
    registerRuntimeRequest(rpc, buddiesRpc.get, input => service.get(input.buddyId)),
    registerRuntimeRequest(rpc, buddiesRpc.create, (input, signal) => service.create(input, signal)),
    registerRuntimeRequest(rpc, buddiesRpc.delete, (input, signal) => service.delete(input, signal)),
    registerRuntimeRequest(rpc, buddiesRpc.resetProfile, (input, signal) => service.resetProfile(input, signal)),
    registerRuntimeRequest(rpc, buddiesRpc.setDefault, (input, signal) => service.setDefault(input, signal)),
    registerRuntimeRequest(rpc, buddiesRpc.update, (input, signal) => service.update(input, signal)),
  ]
  return () => disposers.forEach(dispose => dispose())
}
