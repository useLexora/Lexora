import { CLIPBOARD_IMAGE_MAX_BYTES, CLIPBOARD_IMAGE_MAX_PIXELS } from '@buddy-electron/shared/desktopClipboard'
import { onScopeDispose, shallowRef, watch } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'

export function useImagePreviewActions(source: () => string, name: () => string) {
  const busy = shallowRef(false)
  const feedback = shallowRef<'desktop.imagePreview.copied' | 'desktop.imagePreview.copyFailed' | 'desktop.imagePreview.saveFailed' | 'desktop.imagePreview.referenced' | 'desktop.imagePreview.referenceFailed' | null>(null)
  let request: AbortController | null = null
  const downloads = new Map<string, ReturnType<typeof setTimeout>>()

  function cancel() {
    request?.abort()
    request = null
    busy.value = false
    feedback.value = null
  }

  async function run(action: 'copy' | 'save') {
    if (busy.value || !source())
      return
    const controller = new AbortController()
    request = controller
    busy.value = true
    feedback.value = null
    const src = source()
    const filename = name()
    try {
      const response = await fetch(src, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok)
        throw new Error('Image resource is unavailable')
      const blob = await response.blob()
      controller.signal.throwIfAborted()
      if (action === 'save') {
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        link.click()
        downloads.set(url, setTimeout(() => {
          URL.revokeObjectURL(url)
          downloads.delete(url)
        }, 30_000))
        return
      }
      if (blob.size > CLIPBOARD_IMAGE_MAX_BYTES)
        throw new Error('Image is too large to copy')
      const bitmap = await createImageBitmap(blob)
      try {
        controller.signal.throwIfAborted()
        if (bitmap.width * bitmap.height > CLIPBOARD_IMAGE_MAX_PIXELS)
          throw new Error('Image is too large to copy')
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')
        if (!context)
          throw new Error('Image conversion is unavailable')
        context.drawImage(bitmap, 0, 0)
        const png = await canvas.convertToBlob({ type: 'image/png' })
        if (png.size > CLIPBOARD_IMAGE_MAX_BYTES)
          throw new Error('Image is too large to copy')
        const bytes = new Uint8Array(await png.arrayBuffer())
        controller.signal.throwIfAborted()
        await requireDesktopApi().clipboard.writeImage(bytes)
        if (!controller.signal.aborted)
          feedback.value = 'desktop.imagePreview.copied'
      }
      finally {
        bitmap.close()
      }
    }
    catch {
      if (!controller.signal.aborted)
        feedback.value = action === 'copy' ? 'desktop.imagePreview.copyFailed' : 'desktop.imagePreview.saveFailed'
    }
    finally {
      if (request === controller) {
        request = null
        busy.value = false
      }
    }
  }

  watch(source, cancel, { flush: 'sync' })
  onScopeDispose(() => {
    cancel()
    for (const [url, timer] of downloads) {
      clearTimeout(timer)
      URL.revokeObjectURL(url)
    }
    downloads.clear()
  })

  return { busy, feedback, copy: () => run('copy'), save: () => run('save') }
}
