import type { BrowserWindow } from 'electron'
import type { OcrService } from './OcrService'
import { ipcMain } from 'electron'
import { OCR_IPC } from '../../../shared/images/ocrService'
import { assertTrustedSender } from '../ipc'

export function registerOcrIpc(getWindow: () => BrowserWindow | null, service: OcrService) {
  ipcMain.handle(OCR_IPC.status, (event) => {
    assertTrustedSender(event, getWindow())
    return service.status()
  })
  ipcMain.handle(OCR_IPC.save, (event, raw: unknown) => {
    assertTrustedSender(event, getWindow())
    return service.save(raw)
  })
  return () => {
    ipcMain.removeHandler(OCR_IPC.status)
    ipcMain.removeHandler(OCR_IPC.save)
  }
}
