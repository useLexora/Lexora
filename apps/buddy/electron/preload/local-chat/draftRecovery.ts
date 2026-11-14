import type { DraftRecoveryApi } from '../../../shared/conversation/draftRecovery'
import type { LocalChatApi } from '../../shared/localChatApi'
import { ipcRenderer } from 'electron'
import { draftRecoveryLoadSchema } from '../../../shared/conversation/draftRecovery'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function createDraftRecoveryApi(): Pick<LocalChatApi, 'draftRecovery'> {
  return { draftRecovery: Object.freeze<DraftRecoveryApi>({
    load: async () => draftRecoveryLoadSchema.parse(await ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.draftRecoveryLoad)),
    write: record => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.draftRecoveryWrite, record),
    remove: input => ipcRenderer.invoke(LOCAL_CHAT_IPC_CHANNELS.draftRecoveryRemove, input),
  }) }
}
