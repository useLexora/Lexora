import type { ImageApi } from '../../shared/images/imagePreferences'
import { ipcRenderer } from 'electron'
import { IMAGE_IPC } from '../../shared/images/imagePreferences'
import { OCR_IPC } from '../../shared/images/ocrService'

export function createImageApi(): ImageApi {
  return Object.freeze({
    ocrStatus: () => ipcRenderer.invoke(OCR_IPC.status),
    saveOcr: (input: Parameters<ImageApi['saveOcr']>[0]) => ipcRenderer.invoke(OCR_IPC.save, JSON.parse(JSON.stringify(input))),
    catalog: () => ipcRenderer.invoke(IMAGE_IPC.catalog),
    save: (preferences: Parameters<ImageApi['save']>[0]) => ipcRenderer.invoke(IMAGE_IPC.save, JSON.parse(JSON.stringify(preferences))),
  })
}
