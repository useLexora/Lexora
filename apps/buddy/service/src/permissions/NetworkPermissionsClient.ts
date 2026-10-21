import type { NetworkOperation, NetworkPermissions } from '../../../shared/permissions/networkPermissions'
import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import { networkPermissionsSchema } from '../../../shared/permissions/networkPermissions'
import { networkPermissionsRpc } from '../../../shared/permissions/networkPermissionsRpc'

export interface NetworkPermissionsStore {
  get: (signal?: AbortSignal) => Promise<NetworkPermissions>
  allow: (host: string, operation: NetworkOperation, signal?: AbortSignal) => Promise<void>
}

export class NetworkPermissionsClient implements NetworkPermissionsStore {
  readonly #rpc: Pick<RuntimeRpcPeerContract, 'request'>

  constructor(rpc: Pick<RuntimeRpcPeerContract, 'request'>) {
    this.#rpc = rpc
  }

  async get(signal?: AbortSignal): Promise<NetworkPermissions> {
    return networkPermissionsSchema.parse(await this.#rpc.request(networkPermissionsRpc.get, {}, undefined, signal))
  }

  async allow(host: string, operation: NetworkOperation, signal?: AbortSignal): Promise<void> {
    await this.#rpc.request(networkPermissionsRpc.allow, { host, operation }, undefined, signal)
  }
}
