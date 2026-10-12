import type { LocalChatIpcContext } from './registrar'
import { buddiesRpc } from '../../../shared/buddies/buddyApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerBuddiesIpc({ handle, request }: LocalChatIpcContext): void {
  handle(LOCAL_CHAT_IPC_CHANNELS.buddiesToolOptions, () => request(buddiesRpc.toolOptions, {}))
  handle(LOCAL_CHAT_IPC_CHANNELS.buddiesList, () => request(buddiesRpc.list, {}))
  handle(LOCAL_CHAT_IPC_CHANNELS.buddiesGet, (_event, input) => request(buddiesRpc.get, buddiesRpc.get.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.buddiesCreate, (_event, input) => request(buddiesRpc.create, buddiesRpc.create.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.buddiesDelete, (_event, input) => request(buddiesRpc.delete, buddiesRpc.delete.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.buddiesResetProfile, (_event, input) => request(buddiesRpc.resetProfile, buddiesRpc.resetProfile.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.buddiesSetDefault, (_event, input) => request(buddiesRpc.setDefault, buddiesRpc.setDefault.input.parse(input)))
  handle(LOCAL_CHAT_IPC_CHANNELS.buddiesUpdate, (_event, input) => request(buddiesRpc.update, buddiesRpc.update.input.parse(input)))
}
