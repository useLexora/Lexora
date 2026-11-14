import type { BrowserWindow } from 'electron'
import type { DraftRecoveryOwner } from '../../../shared/conversation/draftRecovery'
import type { ProductIdentity } from '../../../shared/productProtocol/identity'
import { ipcMain } from 'electron'
import { draftRecoveryOwnerSchema, draftRecoveryRecordSchema, draftRecoveryRemovalSchema, sameDraftRecoveryOwner } from '../../../shared/conversation/draftRecovery'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'
import { assertTrustedSender } from '../ipc'
import { RendererDraftStore } from './RendererDraftStore'

export function registerDraftRecoveryIpc(options: { directory: string, getWindow: () => BrowserWindow | null, identity: () => Promise<ProductIdentity | null> }): () => void {
  const store = new RendererDraftStore(options.directory)
  const channels = [LOCAL_CHAT_IPC_CHANNELS.draftRecoveryLoad, LOCAL_CHAT_IPC_CHANNELS.draftRecoveryWrite, LOCAL_CHAT_IPC_CHANNELS.draftRecoveryRemove]
  let activeOwner: DraftRecoveryOwner | null = null
  const owner = async () => {
    const identity = await options.identity()
    activeOwner = identity ? draftRecoveryOwnerSchema.parse({ serviceId: identity.serviceId, profileId: identity.profileId, dataGeneration: identity.dataGeneration, deviceId: identity.deviceId }) : null
    return activeOwner
  }
  ipcMain.handle(channels[0]!, async (event) => {
    assertTrustedSender(event, options.getWindow())
    const current = await owner()
    return { owner: current, records: current ? await store.load() : [] }
  })
  ipcMain.handle(channels[1]!, async (event, input: unknown) => {
    assertTrustedSender(event, options.getWindow())
    const record = draftRecoveryRecordSchema.parse(input)
    const current = activeOwner
    if (!current || !sameDraftRecoveryOwner(current, record.owner))
      throw new Error('DRAFT_RECOVERY_IDENTITY_CHANGED')
    await store.write(record)
  })
  ipcMain.handle(channels[2]!, async (event, input: unknown) => {
    assertTrustedSender(event, options.getWindow())
    const request = draftRecoveryRemovalSchema.parse(input)
    const current = activeOwner
    if (!current || !sameDraftRecoveryOwner(current, request.owner))
      throw new Error('DRAFT_RECOVERY_IDENTITY_CHANGED')
    await store.remove(request.owner, request.editorSessionId, request.sequence)
  })
  return () => channels.forEach(channel => ipcMain.removeHandler(channel))
}
