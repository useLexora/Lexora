import type { LocalChatIpcContext } from './registrar'
import { promptsRpc } from '../../../shared/prompts/promptApi'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerPromptsIpc({ handle, request }: LocalChatIpcContext) {
  handle(LOCAL_CHAT_IPC_CHANNELS.promptsGet, () => request(promptsRpc.get, {}))
}
