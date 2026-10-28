import type { ExtensionPackageRequests, ExtensionPackageTask } from '../../../platform/extensions/extensionPackageProcessing'
import { isMarkedAsUntransferable, parentPort } from 'node:worker_threads'
import { processExtensionPackage } from '../../../platform/extensions/extensionPackageProcessing'
import { ExtensionCompatibilityError } from '../../../shared/extensions/extensionCompatibility'

parentPort!.once('message', async (request: ExtensionPackageRequests[ExtensionPackageTask]) => {
  try {
    const value = await processExtensionPackage(request, undefined, message => parentPort!.postMessage({ kind: 'log', message: message.slice(0, 600) }))
    const files = value instanceof Map ? value : value && typeof value === 'object' && 'files' in value ? value.files : undefined
    const transfer = new Set<ArrayBuffer>()
    for (const [name, content] of files ?? []) {
      const bytes = content.buffer instanceof ArrayBuffer && !isMarkedAsUntransferable(content.buffer) ? content : new Uint8Array(content)
      files!.set(name, bytes)
      transfer.add(bytes.buffer as ArrayBuffer)
    }
    parentPort!.postMessage({ kind: 'result', value }, [...transfer])
  }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    parentPort!.postMessage({ kind: 'error', errno: (error as NodeJS.ErrnoException)?.code, code: /^EXTENSION_[A-Z_]+$/.test(message) ? message : 'EXTENSION_PACKAGE_WORKER_FAILED', ...(error instanceof ExtensionCompatibilityError ? { compatibility: error.review } : {}) })
  }
})
