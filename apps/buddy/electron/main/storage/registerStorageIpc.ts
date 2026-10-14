import type { BrowserWindow } from 'electron'
import type { DesktopEnvironment } from '../app/typing'
import type { StorageBackupService } from './StorageBackupService'
import { dialog, ipcMain, shell } from 'electron'
import { measureStorage } from '../../../platform/storage/storageTree'
import { backupScopes } from '../../../shared/storage/backupScope'
import { STORAGE_CHANNEL, storageCommandSchema } from '../../../shared/storage/storageApi'
import { assertTrustedSender } from '../ipc'

export function registerStorageIpc(environment: DesktopEnvironment, getWindow: () => BrowserWindow | null, backups: StorageBackupService, restart: () => void): () => void {
  ipcMain.handle(STORAGE_CHANNEL, async (event, raw: unknown) => {
    assertTrustedSender(event, getWindow())
    const input = storageCommandSchema.parse(raw)
    switch (input.action) {
      case 'usage': return measureStorage(environment.paths.lexoraHome)
      case 'summary': return backups.summary()
      case 'snapshots': return backups.snapshots.list()
      case 'open': {
        const error = await shell.openPath(environment.paths.lexoraHome)
        if (error)
          throw new Error('STORAGE_OPEN_FAILED')
        return
      }
      case 'choose':
      case 'import':
      case 'export': {
        const window = getWindow()
        if (!window)
          return null
        const selection = await dialog.showOpenDialog(window, { properties: input.action === 'import' ? ['openDirectory'] : ['openDirectory', 'createDirectory'] })
        assertTrustedSender(event, getWindow())
        const selected = selection.filePaths[0]
        if (selection.canceled || !selected)
          return null
        if (input.action === 'choose')
          return selected
        return backups.run<unknown>(() => input.action === 'import' ? backups.import(selected) : backups.export(input.id, selected))
      }
      case 'snapshot': return backups.run(() => backups.create(input.options ?? { scopes: [...backupScopes], credentials: false }))
      case 'delete': return backups.run(() => backups.remove(input.id))
      case 'restore': return backups.run(() => backups.restore(input.id, input.options))
      case 'relocate': return backups.run(() => backups.relocate(input.target))
      case 'cancel': return backups.run(() => backups.cancel())
      case 'restart': return backups.run(async () => restart())
    }
  })
  return () => ipcMain.removeHandler(STORAGE_CHANNEL)
}
