import type { BrowserWindow } from 'electron'
import type { ApplicationLogReader } from '../diagnostics/ApplicationLogReader'
import { ipcMain } from 'electron'
import { applicationLogExportSchema, applicationLogQuerySchema } from '../../../shared/diagnostics/applicationLog'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { saveApplicationDiagnosticBundle } from '../diagnostics/saveApplicationDiagnosticBundle'
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
    const request = applicationLogExportSchema.parse(input)
    if (!window || exporting)
      return { status: 'canceled' }
    exporting = true
    try {
      return await saveApplicationDiagnosticBundle(reader, request, window)
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
