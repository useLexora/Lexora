import type { BrowserWindow } from 'electron'
import type { ApplicationLogApi, ApplicationLogExport, ApplicationLogExportResult } from '../../../shared/diagnostics/applicationLog'
import { writeFile } from 'node:fs/promises'
import { dialog } from 'electron'
import { createApplicationDiagnosticBundle } from './applicationDiagnosticBundle'

export async function saveApplicationDiagnosticBundle(reader: Pick<ApplicationLogApi, 'query'>, input: ApplicationLogExport, window?: BrowserWindow): Promise<ApplicationLogExportResult> {
  const bundle = await createApplicationDiagnosticBundle(reader, input.launch, input.anchor)
  if (!bundle)
    return { status: 'empty' }
  if (window?.isDestroyed())
    return { status: 'canceled' }
  const options = { defaultPath: bundle.filename, filters: [{ name: 'ZIP', extensions: ['zip'] }] }
  const destination = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options))
  if (destination.canceled || !destination.filePath || window?.isDestroyed())
    return { status: 'canceled' }
  await writeFile(destination.filePath, bundle.bytes, { mode: 0o600 })
  return { status: 'saved', errorCount: bundle.errorCount, contextCount: bundle.contextCount }
}
