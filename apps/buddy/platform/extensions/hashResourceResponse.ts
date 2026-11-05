import type { ExtensionResourceHash } from '../../shared/extensions/extensionResources'
import { createHash } from 'node:crypto'
import { extensionResourceHashSchema } from '../../shared/extensions/extensionResources'

export async function hashResourceResponse(response: Response, signal: AbortSignal): Promise<ExtensionResourceHash> {
  const reader = response.body?.getReader()
  let cancellation: Promise<void> | undefined
  const abort = () => {
    cancellation ??= reader?.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const declaredSize = response.headers.get('content-length')
    if (!response.ok || declaredSize === null || !/^\d+$/.test(declaredSize) || !Number.isSafeInteger(Number(declaredSize)))
      throw new Error('EXTENSION_RESOURCE_UNAVAILABLE')
    const hash = createHash('sha256')
    let size = 0
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done)
          break
        size += value.byteLength
        if (size > Number(declaredSize))
          throw new Error('EXTENSION_RESOURCE_CHANGED')
        hash.update(value)
      }
    }
    signal.throwIfAborted()
    if (size !== Number(declaredSize))
      throw new Error('EXTENSION_RESOURCE_CHANGED')
    return extensionResourceHashSchema.parse({ sha256: hash.digest('hex'), size })
  }
  finally {
    signal.removeEventListener('abort', abort)
    await cancellation
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}
