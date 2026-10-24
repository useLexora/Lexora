import type { BrowserWindow } from 'electron'
import type { ExtensionServicePorts } from '../../../platform/extensions/ExtensionService'
import type { ExtensionClipboardData } from '../../../shared/extensions/extensionClipboard'
import { clipboard, ClipboardItem } from 'electron'
import { EXTENSION_CLIPBOARD_BYTES_LIMIT, extensionClipboardSchema } from '../../../shared/extensions/extensionClipboard'

export function createExtensionClipboard(getWindow: () => BrowserWindow | null): NonNullable<ExtensionServicePorts['clipboard']> {
  function authorize(url: string, assertCurrent: () => void) {
    assertCurrent()
    const owner = getWindow()
    if (!owner || owner.isDestroyed() || !owner.isVisible() || owner.isMinimized() || !owner.isFocused() || owner.webContents.isDestroyed() || owner.webContents.focusedFrame?.url !== url)
      throw new Error('EXTENSION_CLIPBOARD_UNAVAILABLE')
  }
  return {
    async read(session, assertCurrent) {
      authorize(session.url, assertCurrent)
      const items = await clipboard.read()
      const data: ExtensionClipboardData = {}
      let bytes = 0
      for (const item of items) {
        for (const [key, mime] of [['text', 'text/plain'], ['html', 'text/html']] as const) {
          if (data[key] !== undefined || !item.types.includes(mime))
            continue
          authorize(session.url, assertCurrent)
          const blob = await item.getType(mime)
          bytes += blob.size
          if (bytes > EXTENSION_CLIPBOARD_BYTES_LIMIT)
            throw new Error('EXTENSION_CLIPBOARD_TOO_LARGE')
          data[key] = await blob.text()
        }
      }
      authorize(session.url, assertCurrent)
      return extensionClipboardSchema.parse(data)
    },
    async write(session, data, assertCurrent) {
      const item = new ClipboardItem({ ...(data.text === undefined ? {} : { 'text/plain': data.text }), ...(data.html === undefined ? {} : { 'text/html': data.html }) })
      authorize(session.url, assertCurrent)
      await clipboard.write([item])
    },
  }
}
