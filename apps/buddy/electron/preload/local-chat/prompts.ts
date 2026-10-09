import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function createPromptsApi(): Pick<LocalChatApi, 'prompts'> {
  return { prompts: Object.freeze({
    get: () => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.promptsGet),
  }) }
}
