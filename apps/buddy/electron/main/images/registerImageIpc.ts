import type { BrowserWindow } from 'electron'
import type { LexoraConfig } from '../../shared/desktopApi'
import type { LexoraConfigStore } from '../config/LexoraConfigStore'
import { ipcMain } from 'electron'
import { IMAGE_IPC, imageCatalogSchema, imageOperations, imagePolicyTargets, imagePreferencesSchema, imageRpc, isOcrReadingSupport, resolveImagePolicy } from '../../../shared/images/imagePreferences'
import { assertTrustedSender } from '../ipc'

export function registerImageIpc(options: {
  getWindow: () => BrowserWindow | null
  config: LexoraConfigStore
  applyConfig: (config: LexoraConfig) => Promise<void>
  request: (method: string, input: object) => Promise<unknown>
}) {
  const catalog = async () => imageCatalogSchema.parse(await options.request(imageRpc.catalog, {}))
  ipcMain.handle(IMAGE_IPC.catalog, (event) => {
    assertTrustedSender(event, options.getWindow())
    return catalog()
  })
  ipcMain.handle(IMAGE_IPC.save, async (event, raw: unknown) => {
    assertTrustedSender(event, options.getWindow())
    const preferences = imagePreferencesSchema.parse(raw)
    const current = await catalog()
    for (const operation of imageOperations) {
      const policy = preferences[operation]
      if (!policy || JSON.stringify(policy) === JSON.stringify(current.preferences[operation]))
        continue
      const previous = operation === 'extract' ? current.preferences.extract : resolveImagePolicy(current.preferences, operation)
      const retainedTargets = previous ? imagePolicyTargets(previous) : []
      const operations = operation === 'generate' ? ['generate', 'edit'] : operation === 'understand' ? ['understand', 'document'] : [operation]
      for (const target of imagePolicyTargets(policy)) {
        if (retainedTargets.some(retained => JSON.stringify(retained) === JSON.stringify(target)))
          continue
        const candidates = operation === 'extract' ? current.readingCandidates.filter(candidate => isOcrReadingSupport(candidate.support)) : [...current.candidates, ...current.readingCandidates]
        if (!candidates.some(candidate => candidate.available && candidate.support.operations.some(operation => operations.includes(operation)) && JSON.stringify(candidate.target) === JSON.stringify(target)))
          throw new Error('IMAGE_MODEL_UNAVAILABLE')
      }
    }
    await options.config.updateImages(current => ({ ...preferences, ocrService: current.ocrService }), options.applyConfig)
  })
  return () => {
    ipcMain.removeHandler(IMAGE_IPC.catalog)
    ipcMain.removeHandler(IMAGE_IPC.save)
  }
}
