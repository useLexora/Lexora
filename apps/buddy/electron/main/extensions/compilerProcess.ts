import process from 'node:process'
import { compileExtensionSource } from '../../../platform/extensions/compileExtensionSource'
import { validateExtensionFiles } from '../../../platform/extensions/extensionFiles'
import { extensionManifestSchema } from '../../../shared/extensions/extensionManifest'

process.parentPort.once('message', (event) => {
  try {
    const files = new Map<string, Uint8Array>(event.data.files)
    validateExtensionFiles(files)
    const manifest = extensionManifestSchema.parse(event.data.manifest)
    const result = compileExtensionSource(files, manifest, message => process.parentPort.postMessage({ kind: 'log', message }))
    validateExtensionFiles(result)
    process.parentPort.postMessage({ kind: 'result', files: [...result] })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    process.parentPort.postMessage({ kind: 'error', code: /^EXTENSION_[A-Z_]+$/.test(message) ? message : 'EXTENSION_SOURCE_COMPILE_FAILED' })
  }
})
