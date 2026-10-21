import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { registerExtensionIpc } from './registerExtensionIpc'
import { extensionShellRpc } from '../../../shared/extensions/extensionShell'

export function registerExtensionShellRpc(peer: RuntimeRpcPeerContract, getShells: () => ReturnType<typeof registerExtensionIpc>['shells'] | null) {
  return peer.onRequest(extensionShellRpc.list, () => getShells()?.list() ?? [])
}
