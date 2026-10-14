import type { BrowserWindow } from 'electron'
import type { DesktopNetwork } from '../network/DesktopNetwork'
import type { StorageBackupService } from '../storage/StorageBackupService'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { SYNC_CHANGED, SYNC_CHANNEL, syncCommandSchema } from '../../../shared/sync/syncApi'
import { assertTrustedSender } from '../ipc'
import { createCredentialVault } from '../secrets/CredentialVault'
import { BackupScheduler } from './BackupScheduler'
import { SyncHub } from './SyncHub'

export async function registerSyncIpc(root: string, network: DesktopNetwork, getWindow: () => BrowserWindow | null, backups: StorageBackupService, privateDirectoriesExecutable?: string): Promise<() => void> {
  const publish = () => {
    const window = getWindow()
    if (window && !window.isDestroyed())
      window.webContents.send(SYNC_CHANGED, state())
  }
  const hub = new SyncHub(root, createCredentialVault({ buddyHome: join(root, 'buddy') }), network.request, publish, privateDirectoriesExecutable)
  const scheduler = new BackupScheduler(root, backups, hub, hub.credentials, publish)
  function state() {
    return { ...hub.state(), schedules: scheduler.state(), scheduleError: scheduler.unavailable }
  }
  backups.protectedSnapshots = () => scheduler.protectedSnapshots()
  let initializationError: unknown
  await hub.initialize().catch((error) => {
    initializationError = error
  })
  await scheduler.initialize()
  const initial = hub.state()
  if (!initializationError && !scheduler.unavailable && initial.enabled && initial.activeConnectionId && !scheduler.state().some(item => item.connectionId === initial.activeConnectionId && item.policy.frequency !== 'manual')) {
    await scheduler.activate(initial.activeConnectionId).catch(() => {
      scheduler.unavailable = true
    })
  }
  scheduler.start()
  ipcMain.handle(SYNC_CHANNEL, async (event, raw: unknown) => {
    assertTrustedSender(event, getWindow())
    if (initializationError)
      throw new Error('SYNC_CONFIGURATION_INVALID')
    const input = syncCommandSchema.parse(raw)
    if (input.action === 'state')
      return state()
    if (input.action === 'credential')
      return hub.credential(input.id)
    if (input.action === 'testConnection')
      return hub.testConnection(input.connection)
    const result = await backups.run(async () => {
      switch (input.action) {
        case 'setEnabled':
          await hub.setEnabled(input.enabled)
          if (input.enabled && hub.state().activeConnectionId)
            await scheduler.activate(hub.state().activeConnectionId!)
          return state()
        case 'selectAdapter':
          await hub.selectAdapter(input.adapter)
          if (hub.state().enabled && hub.state().activeConnectionId)
            await scheduler.activate(hub.state().activeConnectionId!, { immediate: false })
          return state()
        case 'frequency':
          await scheduler.setFrequency(hub.state().activeConnectionId!, input.frequency)
          return state()
        case 'backupNow':
          if (!hub.state().enabled)
            throw new Error('SYNC_DISABLED')
          if (input.configuration) {
            if (input.configuration.connection.adapter !== hub.state().selectedAdapter)
              throw new Error('SYNC_CONNECTION_MISMATCH')
            await hub.save({ ...input.configuration.connection, id: input.configuration.connection.id ?? hub.state().activeConnectionId ?? undefined })
          }
          if (!hub.state().activeConnectionId)
            throw new Error('SYNC_CONNECTION_MISSING')
          await scheduler.requestNow(hub.state().activeConnectionId!, input.options, input.configuration?.frequency)
          return state()
      }
    })
    if (['setEnabled', 'backupNow'].includes(input.action))
      scheduler.kick()
    return result
  })
  return () => {
    scheduler.dispose()
    hub.dispose()
    ipcMain.removeHandler(SYNC_CHANNEL)
  }
}
