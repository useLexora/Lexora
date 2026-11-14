import type { LocalChatIpcContext } from './registrar'
import { privateNetworkManagement } from '../../../shared/privateNetwork/management'
import { PRIVATE_NETWORK_IPC_PREFIX } from '../../shared/privateNetworkApi'

export function registerPrivateNetworkIpc({ handle, options }: LocalChatIpcContext): void {
  for (const [name, contract] of Object.entries(privateNetworkManagement)) {
    handle(`${PRIVATE_NETWORK_IPC_PREFIX}${name}`, async (_event, input) => {
      const value = contract.input.parse(input)
      return contract.response.parse(await options.runtime.request(contract.method, value))
    })
  }
}
