import type { PrivateNetworkManagementApi } from '../../../shared/privateNetwork/management'
import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { privateNetworkManagement } from '../../../shared/privateNetwork/management'
import { PRIVATE_NETWORK_IPC_PREFIX } from '../../shared/privateNetworkApi'

export function createPrivateNetworkApi(): Pick<LocalChatApi, 'privateNetwork'> {
  return {
    privateNetwork: Object.freeze(Object.fromEntries(Object.keys(privateNetworkManagement).map(name => [
      name,
      (input: unknown) => ipcRenderer.invoke(`${PRIVATE_NETWORK_IPC_PREFIX}${name}`, input),
    ])) as PrivateNetworkManagementApi),
  }
}
