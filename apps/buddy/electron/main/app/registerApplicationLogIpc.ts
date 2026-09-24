import type { BrowserWindow } from 'electron'
import type { ApplicationLogReader } from '../diagnostics/ApplicationLogReader'
import { writeFile } from 'node:fs/promises'
import { dialog, ipcMain } from 'electron'
import { applicationLogExportSchema, applicationLogQuerySchema } from '../../../shared/diagnostics/applicationLog'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { createApplicationDiagnosticBundle } from '../diagnostics/applicationDiagnosticBundle'
import { assertTrustedSender } from '../ipc'

export function registerApplicationLogIpc(reader: ApplicationLogReader, getWindow: () => BrowserWindow | null): () => void {
  let exporting = false
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appLogsQuery, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow())
    const query = applicationLogQuerySchema.parse(input)
    try {
      return await reader.query(query)
    }
    catch {
      throw new Error('APPLICATION_LOG_READ_FAILED')
    }
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appLogsExportDiagnostics, async (event, input: unknown) => {
    const window = getWindow()
    assertTrustedSender(event, window)
    const { launch } = applicationLogExportSchema.parse(input)
    if (!window || exporting)
      return { status: 'canceled' }
    exporting = true
    try {
      const bundle = await createApplicationDiagnosticBundle(reader, launch)
      if (!bundle)
        return { status: 'empty' }
      if (window.isDestroyed())
        return { status: 'canceled' }
      const destination = await dialog.showSaveDialog(window, {
        defaultPath: bundle.filename,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (destination.canceled || !destination.filePath || window.isDestroyed())
        return { status: 'canceled' }
      await writeFile(destination.filePath, bundle.bytes, { mode: 0o600 })
      return { status: 'saved', errorCount: bundle.errorCount, contextCount: bundle.contextCount }
    }
    catch {
      throw new Error('APPLICATION_LOG_EXPORT_FAILED')
    }
    finally {
      exporting = false
    }
  })
  return () => {
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.appLogsQuery)
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.appLogsExportDiagnostics)
  }
}
