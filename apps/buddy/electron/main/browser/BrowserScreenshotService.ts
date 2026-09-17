import type { BrowserWindow } from 'electron'
import type { BrowserScreenshotResult } from '../../../shared/browser/browserDesktopApi'
import type { BrowserPreferences } from '../../../shared/browser/browserPreferences'
import type { BrowserPageScreenshot } from './BrowserHost'
import { writeFile } from 'node:fs/promises'
import { clipboard, ClipboardItem, dialog } from 'electron'

export class BrowserScreenshotService {
  readonly #getPreferences: () => BrowserPreferences

  constructor(getPreferences: () => BrowserPreferences) {
    this.#getPreferences = getPreferences
  }

  async capture(window: BrowserWindow, capturePage: () => Promise<BrowserPageScreenshot>): Promise<BrowserScreenshotResult> {
    const destination = this.#getPreferences().screenshotDestination
    const screenshot = await capturePage()
    if (destination === 'clipboard') {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Uint8Array.from(screenshot.bytes)], { type: 'image/png' }) })])
      return 'copied'
    }
    const result = await dialog.showSaveDialog(window, {
      defaultPath: createScreenshotFileName(screenshot.title),
      filters: [{ extensions: ['png'], name: 'PNG image' }],
    })
    if (result.canceled || !result.filePath)
      return 'canceled'
    await writeFile(result.filePath, screenshot.bytes)
    return 'saved'
  }
}

function createScreenshotFileName(title: string): string {
  const base = [...title]
    .filter(character => (character.codePointAt(0) ?? 0) > 31)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80)
  const safeBase = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(base) ? `screenshot-${base}` : base
  return `${safeBase || 'browser-screenshot'}.png`
}
