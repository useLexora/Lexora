import type { BrowserWindow, WebFrameMain } from 'electron'
import type { DesktopDiagnosticEvent } from '../desktopDiagnostics'
import type { ApplicationLogReader } from '../diagnostics/ApplicationLogReader'
import { ipcMain } from 'electron'
import { applicationLogExportSchema, applicationLogQuerySchema } from '../../../shared/diagnostics/applicationLog'
import { rendererDiagnosticReportSchema } from '../../../shared/diagnostics/rendererDiagnostic'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { saveApplicationDiagnosticBundle } from '../diagnostics/saveApplicationDiagnosticBundle'
import { assertTrustedSender } from '../ipc'

export function registerApplicationLogIpc(reader: ApplicationLogReader, getWindow: () => BrowserWindow | null, record: (event: DesktopDiagnosticEvent) => boolean): () => void {
  let exporting = false
  const producers = new WeakMap<WebFrameMain, Map<string, { id: string, sequence: number, accepted: boolean }>>()
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appLogsReport, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow())
    const report = rendererDiagnosticReportSchema.parse(input)
    const frame = event.senderFrame!
    const sources = producers.get(frame) ?? new Map<string, { id: string, sequence: number, accepted: boolean }>()
    producers.set(frame, sources)
    let source = sources.get(report.sourceId)
    if (!source) {
      if (sources.size >= 32)
        return false
      source = { id: crypto.randomUUID(), sequence: 0, accepted: false }
      sources.set(report.sourceId, source)
    }
    if (report.diagnostic.sourceSequence <= source.sequence)
      return report.diagnostic.sourceSequence === source.sequence && source.accepted
    source.sequence = report.diagnostic.sourceSequence
    source.accepted = false
    try {
      source.accepted = record({ ...report.diagnostic, scope: 'desktop', component: 'renderer.workbench', sourceId: `renderer:${source.id}`, producerInstanceId: source.id })
      return source.accepted
    }
    catch {
      return false
    }
  })
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
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.appLogsReport)
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.appLogsQuery)
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.appLogsExportDiagnostics)
  }
}
